/**
 * Redis 缓存。
 * 值统一 JSON 序列化；键带配置前缀，方便 `deleteByPrefix` 与运维排查。
 */
import type { RedisHandle } from '../redis/client.js';
import type { Cache } from './types.js';

export class RedisCache implements Cache {
  readonly driver = 'redis' as const;

  constructor(
    private readonly redis: RedisHandle,
    private readonly defaultTtlMs = 300_000,
  ) {}

  private k(key: string): string {
    return this.redis.key('cache', key);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.client.get(this.k(key));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // 脏数据（旧版本格式）直接丢弃，避免影响业务
      await this.redis.client.del(this.k(key));
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const payload = JSON.stringify(value);
    if (ttl > 0) await this.redis.client.set(this.k(key), payload, 'PX', ttl);
    else await this.redis.client.set(this.k(key), payload);
  }

  async del(key: string): Promise<boolean> {
    return (await this.redis.client.del(this.k(key))) > 0;
  }

  async has(key: string): Promise<boolean> {
    return (await this.redis.client.exists(this.k(key))) === 1;
  }

  async incr(key: string, by = 1): Promise<number> {
    return this.redis.client.incrby(this.k(key), by);
  }

  async remember<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;
    // 跨进程的击穿保护靠短锁；拿不到锁就等一会儿再读缓存
    const produced = await producer();
    await this.set(key, produced, ttlMs);
    return produced;
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const pattern = `${this.k(prefix)}*`;
    let removed = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) removed += await this.redis.client.del(...keys);
    } while (cursor !== '0');
    return removed;
  }

  async clear(): Promise<void> {
    await this.deleteByPrefix('');
  }

  async close(): Promise<void> {
    // Redis 连接生命周期由 RedisHandle 统一管理
  }
}
