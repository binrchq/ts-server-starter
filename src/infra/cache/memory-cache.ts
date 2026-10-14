/**
 * 进程内缓存。用于单实例部署与本地开发；多实例下各自为政，
 * 因此默认只缓存「可重建」的派生数据。
 *
 * 三个必须处理的细节：
 *  - 过期惰性清理 + 容量上限 LRU 淘汰（否则内存无限增长）
 *  - 并发 miss 合并（in-flight map），避免缓存击穿把下游打挂
 *  - 存储的是深拷贝（structuredClone），防止调用方改到缓存对象
 */
import type { Cache } from './types.js';

interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface MemoryCacheOptions {
  maxSize?: number;
  defaultTtlMs?: number;
}

export class MemoryCache implements Cache {
  readonly driver = 'memory' as const;

  private readonly store = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.defaultTtlMs = options.defaultTtlMs ?? 300_000;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // 命中即提到队尾，实现 LRU
    this.store.delete(key);
    this.store.set(key, entry);
    return clone(entry.value) as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const ttl = ttlMs ?? this.defaultTtlMs;
    if (this.store.size >= this.maxSize && !this.store.has(key)) this.evict();
    this.store.set(key, {
      value: clone(value),
      expiresAt: ttl > 0 ? Date.now() + ttl : Number.POSITIVE_INFINITY,
    });
  }

  async del(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async incr(key: string, by = 1): Promise<number> {
    const current = (await this.get<number>(key)) ?? 0;
    const next = current + by;
    const existing = this.store.get(key);
    await this.set(key, next, existing ? Math.max(0, existing.expiresAt - Date.now()) : undefined);
    return next;
  }

  async remember<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return (await pending) as T;

    const promise = (async () => {
      const produced = await producer();
      await this.set(key, produced, ttlMs);
      return produced;
    })();

    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.inflight.clear();
  }

  async close(): Promise<void> {
    await this.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private evict(): void {
    // Map 的迭代顺序即插入顺序，最早的 key 最久未使用
    const oldest = this.store.keys().next();
    if (!oldest.done) this.store.delete(oldest.value);
  }
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}
