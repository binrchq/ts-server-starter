/**
 * Etcd 分布式状态。
 *
 * 与 redis 驱动的本质区别：etcd 的每次写入都会递增 key 的 `version`，
 * 因此可以用 **版本号比较** 做真正的 CAS（而不是「读-改-写」的近似原子），
 * 且锁可以直接绑定原生租约（lease）。这正是 leader election / fencing token
 * 需要的语义。
 *
 * 依赖方向：本文件只依赖 `EtcdKvLike` 这个最小原语接口，
 * 真实 etcd3 客户端在 `etcd-client.ts` 里适配。好处是 CAS / 锁 / 计数
 * 这些**容易写错**的逻辑可以用内存实现完整测出来，不需要起 etcd。
 *
 * 写错会静默出事的三个点（都在这里处理）：
 *  1. 加锁必须 compareAndSet(version=0) —— 「先 get 再 put」之间有窗口期
 *  2. 解锁/续期必须带上当前 version —— 否则会动到别人的锁
 *  3. increment 必须 CAS 重试，而不是 get 之后直接 put（并发下会丢计数）
 */

import { randomUUID } from 'node:crypto';
import type { Lock, StateAdapter } from './types.js';

/**
 * 一条 etcd 记录的最小视图。
 *
 * `version` 是一个**不透明的 CAS 令牌**，0 表示「key 不存在」。
 * 真实 etcd 实现用 `mod_revision`（集群内全局单调）填充它，
 * 而不是 etcd 意义上的 `version` —— 后者在删除后会重置，无法做 fencing。
 */
export interface EtcdEntry {
  value: string;
  version: number;
}

/**
 * etcd KV 的最小原语。
 *
 * `compareAndSet` 的语义是原子比较并写入：
 *  - expectedVersion === 0 时表示「仅当 key 不存在才创建」
 *  - 比较失败返回 null（不抛错），调用方据此决定重试或放弃
 *  - 成功返回新的 version（令牌）
 *
 * TTL 通过租约实现：`ttlMs` 为 0 / undefined 表示永不过期。
 */
export interface EtcdKvLike {
  get(key: string): Promise<EtcdEntry | null>;
  /** 无条件写入。不返回 revision：盲写场景下调用方不应依赖它 */
  put(key: string, value: string, ttlMs?: number): Promise<void>;
  /** 指定 version 时为 CAS 删除；不指定则无条件删除 */
  delete(key: string, version?: number): Promise<boolean>;
  compareAndSet(key: string, expectedVersion: number, value: string, ttlMs?: number): Promise<number | null>;
  close(): Promise<void>;
}

/**
 * CAS 重试上限。
 *
 * etcd 没有 INCR 原语，increment 只能「读→CAS」重试；N 个并发竞争者
 * 最坏需要约 N 轮才能全部成功，因此上限要显著大于合理并发数。
 * 超过上限意味着持续高竞争，再重试只会放大惊群 —— 抛出比无休止重试好。
 */
const MAX_CAS_RETRIES = 128;

function parseStored<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

export class EtcdState implements StateAdapter {
  readonly driver = 'etcd' as const;

  constructor(
    private readonly kv: EtcdKvLike,
    private readonly keyPrefix = '',
  ) {}

  private k(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = await this.kv.get(this.k(key));
    if (!entry) return undefined;
    return parseStored<T>(entry.value);
  }

  async set<T>(key: string, value: T, ttlMs = 0): Promise<void> {
    await this.kv.put(this.k(key), JSON.stringify(value), ttlMs || undefined);
  }

  async delete(key: string): Promise<boolean> {
    return this.kv.delete(this.k(key));
  }

  async setIfAbsent<T>(key: string, value: T, ttlMs = 0): Promise<boolean> {
    const created = await this.kv.compareAndSet(this.k(key), 0, JSON.stringify(value), ttlMs || undefined);
    return created !== null;
  }

  /**
   * 原子自增。
   *
   * 注意：etcd 没有 INCR 原语，这里用「读当前值 → CAS 写回」的乐观锁重试。
   * 与 redis 驱动的一个行为差异：每次成功写入都会重新绑定租约，
   * 因此 TTL 是**滑动窗口**而不是固定窗口。限流若对此敏感，请用 redis 驱动。
   */
  async increment(key: string, by = 1, ttlMs = 0): Promise<number> {
    const fullKey = this.k(key);
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const entry = await this.kv.get(fullKey);
      if (!entry) {
        const created = await this.kv.compareAndSet(fullKey, 0, JSON.stringify(by), ttlMs || undefined);
        if (created !== null) return by;
        continue;
      }
      const current = Number(parseStored<unknown>(entry.value)) || 0;
      const next = current + by;
      const updated = await this.kv.compareAndSet(fullKey, entry.version, JSON.stringify(next), ttlMs || undefined);
      if (updated !== null) return next;
    }
    throw new Error(`etcd increment contention: failed to update "${key}" after ${MAX_CAS_RETRIES} retries`);
  }

  async acquireLock(key: string, ttlMs: number): Promise<Lock | null> {
    const fullKey = this.k(key);
    const token = randomUUID();
    // 创建式 CAS：version===0 表示 key 不存在。中间的窗口期由 etcd 事务消除。
    const initial = await this.kv.compareAndSet(fullKey, 0, token, ttlMs);
    if (initial === null) return null;
    // 显式标注 number：闭包里会被重新赋值，TS 无法保留上面的 null 收窄
    let version: number = initial;

    let held = true;
    return {
      key,
      get held() {
        return held;
      },
      release: async () => {
        // 带 version 删除：即便 TTL 已过期且锁被他人获取，也不会误删别人的锁
        const removed = await this.kv.delete(fullKey, version);
        held = false;
        return removed;
      },
      extend: async (nextTtl: number) => {
        // CAS 到「同 token + 同 version」，保证只有当前持有者能续期
        const next = await this.kv.compareAndSet(fullKey, version, token, nextTtl);
        if (next === null) {
          held = false;
          return false;
        }
        version = next;
        held = true;
        return true;
      },
    };
  }

  async close(): Promise<void> {
    await this.kv.close();
  }
}
