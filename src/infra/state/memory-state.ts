/**
 * 进程内状态实现。仅用于单实例/开发环境。
 */
import { randomUUID } from 'node:crypto';
import { NotImplementedError } from '../../shared/errors.js';
import type { Lock, StateAdapter } from './types.js';

interface ValueEntry {
  value: unknown;
  expiresAt: number;
}

export class MemoryState implements StateAdapter {
  readonly driver = 'memory' as const;

  private readonly values = new Map<string, ValueEntry>();
  private readonly locks = new Map<string, { token: string; expiresAt: number }>();
  private readonly defaultKeyPrefix: string;

  constructor(keyPrefix = '') {
    this.defaultKeyPrefix = keyPrefix;
  }

  private k(key: string): string {
    return `${this.defaultKeyPrefix}${key}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.values.get(this.k(key));
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(this.k(key));
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs = 0): Promise<void> {
    this.values.set(this.k(key), {
      value,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : Number.POSITIVE_INFINITY,
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(this.k(key));
  }

  async setIfAbsent<T>(key: string, value: T, ttlMs = 0): Promise<boolean> {
    // 关键：检查与写入之间**不能有 await**。
    // 一旦中间让出事件循环，并发的 N 个调用会全部读到「不存在」，
    // 于是 N 个都写入成功 —— 幂等语义直接失效。
    const fullKey = this.k(key);
    const existing = this.values.get(fullKey);
    if (existing !== undefined && existing.expiresAt > Date.now()) return false;
    this.values.set(fullKey, {
      value,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : Number.POSITIVE_INFINITY,
    });
    return true;
  }

  async increment(key: string, by = 1, ttlMs = 0): Promise<number> {
    // 同上：读-改-写必须在一段同步代码里完成，否则并发自增会丢更新。
    // 这类 bug 在限流场景下表现为「限制被绕过」，而且测试不并发就测不出来。
    const fullKey = this.k(key);
    const existing = this.values.get(fullKey);
    const alive = existing !== undefined && existing.expiresAt > Date.now();
    const current = alive ? (existing.value as number) : 0;
    const next = current + by;
    // 已存在时保留原 TTL：否则每次自增都会把限流窗口往后推，等于没有窗口
    const expiresAt = alive ? existing.expiresAt : ttlMs > 0 ? Date.now() + ttlMs : Number.POSITIVE_INFINITY;
    this.values.set(fullKey, { value: next, expiresAt });
    return next;
  }

  async acquireLock(key: string, ttlMs: number): Promise<Lock | null> {
    const fullKey = this.k(key);
    const existing = this.locks.get(fullKey);
    if (existing && existing.expiresAt > Date.now()) return null;

    const token = randomUUID();
    const expiresAt = Date.now() + ttlMs;
    const locks = this.locks; // 闭包内不能用 this：对象字面量的 getter/method 有自己的 this
    locks.set(fullKey, { token, expiresAt });

    const stillMine = (): boolean => locks.get(fullKey)?.token === token;

    return {
      key,
      get held() {
        const current = locks.get(fullKey);
        return current?.token === token && current.expiresAt > Date.now();
      },
      release: async () => {
        if (!stillMine()) return false;
        locks.delete(fullKey);
        return true;
      },
      extend: async (nextTtl: number) => {
        const current = locks.get(fullKey);
        if (!current || current.token !== token) return false;
        current.expiresAt = Date.now() + nextTtl;
        return true;
      },
    };
  }

  async close(): Promise<void> {
    this.values.clear();
    this.locks.clear();
  }

  /** 供单进程内的强一致场景使用（多实例会抛错，避免被误当成分布式锁） */
  assertSingleInstance(): void {
    if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') {
      throw new NotImplementedError('MemoryState is not safe across instances; configure state.driver=redis');
    }
  }
}
