/**
 * 缓存工厂。redis 不可用时自动降级到进程内缓存并给出 warning ——
 * 缓存是加速手段，不该因为 Redis 抖动导致整个服务起不来。
 */
import type { Config } from '../../config/schema.js';
import type { Logger } from '../../shared/logger.js';
import { createRedisClient } from '../redis/client.js';
import { MemoryCache } from './memory-cache.js';
import { RedisCache } from './redis-cache.js';
import type { Cache } from './types.js';

export * from './types.js';
export { MemoryCache } from './memory-cache.js';
export { RedisCache } from './redis-cache.js';

export interface CreateCacheResult {
  cache: Cache;
  close: () => Promise<void>;
}

export async function createCache(cfg: Config, logger: Logger): Promise<CreateCacheResult> {
  const log = logger.component('cache');

  if (cfg.cache.driver === 'memory') {
    const cache = new MemoryCache({ maxSize: cfg.cache.size, defaultTtlMs: cfg.cache.defaultTtlMs });
    return { cache, close: () => cache.close() };
  }

  try {
    const redis = createRedisClient({ config: cfg.redis, keyPrefix: cfg.cache.keyPrefix });
    await redis.ping();
    log.info('redis cache ready', { host: cfg.redis.host, port: cfg.redis.port, db: cfg.cache.database });
    return { cache: new RedisCache(redis, cfg.cache.defaultTtlMs), close: () => redis.close() };
  } catch (err) {
    log.warn('redis unavailable, falling back to in-memory cache', { error: (err as Error).message });
    const cache = new MemoryCache({ maxSize: cfg.cache.size, defaultTtlMs: cfg.cache.defaultTtlMs });
    return { cache, close: () => cache.close() };
  }
}
