/**
 * 状态适配器工厂。
 *
 * 默认关闭（state.enabled=false）：分布式锁是把双刃剑，
 * 没想清楚语义就启用，容易出现「锁比临界区长」这种隐蔽故障。
 */
import type { Config } from '../../config/schema.js';
import type { Logger } from '../../shared/logger.js';
import { createRedisClient } from '../redis/client.js';
import { createEtcd3Kv } from './etcd-client.js';
import { EtcdState } from './etcd-state.js';
import { MemoryState } from './memory-state.js';
import { RedisState } from './redis-state.js';
import type { StateAdapter } from './types.js';

export * from './types.js';
export { MemoryState } from './memory-state.js';
export { RedisState } from './redis-state.js';
export { EtcdState, type EtcdKvLike, type EtcdEntry } from './etcd-state.js';
export { createEtcd3Kv, Etcd3Kv } from './etcd-client.js';

export interface CreateStateResult {
  state: StateAdapter;
  close: () => Promise<void>;
}

export async function createState(cfg: Config, logger: Logger): Promise<CreateStateResult> {
  const log = logger.component('state');

  if (!cfg.state.enabled) {
    log.debug('state adapter disabled by config');
    const state = new MemoryState(cfg.state.keyPrefix);
    return { state, close: () => state.close() };
  }

  if (cfg.state.driver === 'redis') {
    const redis = createRedisClient({ config: cfg.redis, keyPrefix: '' });
    await redis.ping();
    log.info('redis state ready', { keyPrefix: cfg.state.keyPrefix });
    const state = new RedisState(redis, cfg.state.keyPrefix);
    return {
      state,
      close: async () => {
        await state.close();
        await redis.close();
      },
    };
  }

  if (cfg.state.driver === 'etcd') {
    const { kv, close } = await createEtcd3Kv(cfg.state.endpoints);
    // 建连是惰性的，这里主动读一次确认节点可达（早失败优于请求期 500）
    await kv.get('__state_healthcheck__');
    log.info('etcd state ready', { endpoints: cfg.state.endpoints, keyPrefix: cfg.state.keyPrefix });
    const state = new EtcdState(kv, cfg.state.keyPrefix);
    // EtcdState.close() 会调用 kv.close()，与返回的 close 是同一个，直接用即可
    return { state, close };
  }

  const state = new MemoryState(cfg.state.keyPrefix);
  if (cfg.environment === 'prod') {
    log.warn('state.driver=memory in production: distributed locks will NOT work across instances');
  }
  return { state, close: () => state.close() };
}
