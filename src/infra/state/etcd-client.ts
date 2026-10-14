/**
 * etcd3 客户端适配。
 *
 * 这里把 etcd3 的高层 builder API（get/put/if-then-commit/lease）翻译成
 * `EtcdKvLike` 这一组最小原语。分层的意义：
 *  - `etcd-state.ts` 里的 CAS / 锁逻辑可以用内存原语完整测试，不需要起 etcd
 *  - 真实 SDK 的 API 变化被限制在这一个文件里
 *
 * etcd3 是**可选依赖**，因此这里不 import 它的类型，全程结构类型 +
 * 动态 import —— 不装 etcd3 的项目依然能 typecheck 和构建。
 */
import type { EtcdEntry, EtcdKvLike } from './etcd-state.js';

interface RawKeyValue {
  value: Uint8Array | string;
  version: string | number;
  mod_revision?: string | number;
}
interface RangeResponse {
  kvs?: RawKeyValue[];
}
interface DeleteResponse {
  deleted: string | number;
}
interface TxnResponse {
  succeeded: boolean;
}
interface LeaseLike {
  revoke(options?: unknown): Promise<void>;
}
interface PutBuilderLike {
  value(value: string): PutBuilderLike;
  lease(lease: unknown): PutBuilderLike;
  exec(): Promise<unknown>;
}
interface DeleteBuilderLike {
  key(key: string): DeleteBuilderLike;
  exec(): Promise<DeleteResponse>;
}
interface RangeBuilderLike {
  exec(): Promise<RangeResponse>;
}
interface ComparatorBuilderLike {
  then(...ops: unknown[]): ComparatorBuilderLike;
  commit(): Promise<TxnResponse>;
}
interface Etcd3ClientLike {
  get(key: string): RangeBuilderLike;
  put(key: string): PutBuilderLike;
  delete(): DeleteBuilderLike;
  if(key: string, column: string, cmp: string, value: string | number): ComparatorBuilderLike;
  lease(ttlSeconds: number, options?: { autoKeepAlive?: boolean }): LeaseLike;
  close(): Promise<void>;
}

/** 强制把毫秒 TTL 转成至少 1 秒的租约（etcd 的租约粒度是秒） */
function toLeaseSeconds(ttlMs?: number): number {
  return Math.max(1, Math.ceil((ttlMs ?? 0) / 1000));
}

export class Etcd3Kv implements EtcdKvLike {
  /** 本实例创建的租约，按 key 记录，用于覆盖/删除/关闭时回收 */
  private readonly leases = new Map<string, LeaseLike>();

  constructor(private readonly client: Etcd3ClientLike) {}

  private static decode(kv: RawKeyValue): EtcdEntry {
    const value = typeof kv.value === 'string' ? kv.value : Buffer.from(kv.value).toString('utf8');
    // 关键：用 mod_revision（集群内全局单调）而不是 version 作为 CAS 令牌。
    // etcd 的 version 在 key 被删除后会重置，因此「过期持有者用旧 version 删除」
    // 有可能误删掉刚重建的新锁；mod_revision 不会回退，天然是 fencing token。
    const revision = kv.mod_revision ?? kv.version;
    return { value, version: Number(revision) };
  }

  /**
   * 为一次写入准备新租约，**不会**立刻撤销旧租约。
   *
   * 为什么不能先 revoke：etcd 的语义是「撤销租约 = 删除挂在它上面的 key」，
   * 先撤销会把自己要比较的 key 删掉，CAS 的前置条件当场失效
   * （表现为「本该失败的 compareAndSet 却成功了」）。
   * 因此旧租约必须等新值写入成功、key 已经改挂到新租约之后再回收。
   */
  private beginLeaseSwap(key: string, ttlMs?: number): { lease?: LeaseLike; previous?: LeaseLike } {
    const previous = this.leases.get(key);
    if (ttlMs && ttlMs > 0) {
      // autoKeepAlive:false 是关键 —— 默认 true 会不断续租，TTL 永远不会到期
      const lease = this.client.lease(toLeaseSeconds(ttlMs), { autoKeepAlive: false });
      this.leases.set(key, lease);
      return { lease, previous };
    }
    this.leases.delete(key); // 写入不带 TTL → key 变为永久，旧租约随后回收
    return { previous };
  }

  private restoreLease(key: string, previous?: LeaseLike): void {
    if (previous) this.leases.set(key, previous);
    else this.leases.delete(key);
  }

  private async revoke(lease: LeaseLike): Promise<void> {
    await lease.revoke().catch(() => {
      /* 租约可能已自然过期；回收失败不影响主流程 */
    });
  }

  private async revokeLease(key: string): Promise<void> {
    const lease = this.leases.get(key);
    if (!lease) return;
    this.leases.delete(key);
    await this.revoke(lease);
  }

  async get(key: string): Promise<EtcdEntry | null> {
    const response = await this.client.get(key).exec();
    const raw = response.kvs?.[0];
    return raw ? Etcd3Kv.decode(raw) : null;
  }

  async put(key: string, value: string, ttlMs?: number): Promise<void> {
    const { lease, previous } = this.beginLeaseSwap(key, ttlMs);
    const builder = this.client.put(key).value(value);
    if (lease) builder.lease(lease);
    try {
      await builder.exec();
    } catch (err) {
      this.restoreLease(key, previous);
      if (lease) await this.revoke(lease);
      throw err;
    }
    // 新值已写入，key 不再挂旧租约，此时回收才安全
    if (previous && previous !== lease) await this.revoke(previous);
  }

  async delete(key: string, version?: number): Promise<boolean> {
    let deleted: boolean;
    if (version === undefined) {
      const response = await this.client.delete().key(key).exec();
      deleted = Number(response.deleted) > 0;
    } else {
      // 带 mod_revision 比较的删除：TTL 过期后锁易主时，旧持有者删不掉新持有者的锁
      const response = await this.client.if(key, 'Mod', '==', version).then(this.client.delete().key(key)).commit();
      deleted = response.succeeded;
    }
    if (deleted) await this.revokeLease(key);
    return deleted;
  }

  async compareAndSet(key: string, expectedVersion: number, value: string, ttlMs?: number): Promise<number | null> {
    const { lease, previous } = this.beginLeaseSwap(key, ttlMs);
    const builder = this.client.put(key).value(value);
    if (lease) builder.lease(lease);
    let response: TxnResponse;
    try {
      response = await this.client.if(key, 'Mod', '==', expectedVersion).then(builder).commit();
    } catch (err) {
      this.restoreLease(key, previous);
      if (lease) await this.revoke(lease);
      throw err;
    }
    if (!response.succeeded) {
      // CAS 失败：key 未被改动，previous 仍然是它的租约，要恢复映射
      this.restoreLease(key, previous);
      if (lease) await this.revoke(lease);
      return null;
    }
    if (previous && previous !== lease) await this.revoke(previous);
    return expectedVersion + 1;
  }

  async close(): Promise<void> {
    const keys = [...this.leases.keys()];
    await Promise.all(keys.map((key) => this.revokeLease(key)));
    await this.client.close();
  }
}

/**
 * 创建 etcd 原语。动态 import 可选依赖，缺失时给出可执行的安装提示，
 * 而不是一个 `Cannot find module`。
 */
export async function createEtcd3Kv(endpoints: string[]): Promise<{ kv: EtcdKvLike; close: () => Promise<void> }> {
  const moduleName = 'etcd3';
  let Etcd3Ctor: new (options: { hosts: string[] }) => Etcd3ClientLike;
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as {
      Etcd3: new (options: { hosts: string[] }) => Etcd3ClientLike;
    };
    Etcd3Ctor = mod.Etcd3;
  } catch {
    throw new Error('etcd state driver requires the optional dependency "etcd3". Install it with: pnpm add etcd3');
  }

  const client = new Etcd3Ctor({ hosts: endpoints });
  const kv = new Etcd3Kv(client);
  return { kv, close: () => kv.close() };
}
