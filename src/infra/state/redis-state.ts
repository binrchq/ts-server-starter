/**
 * Redis 分布式状态。
 *
 * 锁的正确实现要点（网上大量示例都写错了）：
 *  1. 加锁必须 SET key token NX PX ttl —— 三步非原子会留下死锁窗口
 *  2. 解锁必须比对 token —— 否则会释放别人的锁（超时后原持有者释放新持有者的锁）
 *  3. 比对 + 删除必须在一个 Lua 脚本里 —— 否则比对通过后、删除前锁可能已易主
 */
import { randomUUID } from 'node:crypto';
import type { RedisHandle } from '../redis/client.js';
import type { Lock, StateAdapter } from './types.js';

/** KEYS[1]=锁键, ARGV[1]=期望 token */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** KEYS[1]=锁键, ARGV[1]=期望 token, ARGV[2]=新 TTL(ms) */
const EXTEND_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export class RedisState implements StateAdapter {
  readonly driver = 'redis' as const;

  constructor(
    private readonly redis: RedisHandle,
    private readonly keyPrefix: string,
  ) {}

  private k(key: string): string {
    return this.redis.key(this.keyPrefix, key);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.client.get(this.k(key));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async set<T>(key: string, value: T, ttlMs = 0): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlMs > 0) await this.redis.client.set(this.k(key), payload, 'PX', ttlMs);
    else await this.redis.client.set(this.k(key), payload);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.redis.client.del(this.k(key))) > 0;
  }

  async setIfAbsent<T>(key: string, value: T, ttlMs = 0): Promise<boolean> {
    const payload = JSON.stringify(value);
    const result =
      ttlMs > 0
        ? await this.redis.client.set(this.k(key), payload, 'PX', ttlMs, 'NX')
        : await this.redis.client.set(this.k(key), payload, 'NX');
    return result === 'OK';
  }

  async increment(key: string, by = 1, ttlMs = 0): Promise<number> {
    const fullKey = this.k(key);
    const next = await this.redis.client.incrby(fullKey, by);
    // 只在第一次自增时设置 TTL，保证窗口固定（而不是每次自增都续期）
    if (ttlMs > 0 && next === by) await this.redis.client.pexpire(fullKey, ttlMs);
    return next;
  }

  async acquireLock(key: string, ttlMs: number): Promise<Lock | null> {
    const fullKey = this.k(key);
    const token = randomUUID();
    const acquired = await this.redis.client.set(fullKey, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') return null;

    let held = true;
    return {
      key,
      get held() {
        return held;
      },
      release: async () => {
        const removed = (await this.redis.client.eval(RELEASE_SCRIPT, 1, fullKey, token)) as number;
        held = false;
        return removed === 1;
      },
      extend: async (nextTtl: number) => {
        const extended = (await this.redis.client.eval(EXTEND_SCRIPT, 1, fullKey, token, String(nextTtl))) as number;
        held = extended === 1;
        return held;
      },
    };
  }

  async close(): Promise<void> {
    // 连接生命周期由 RedisHandle 管理
  }
}
