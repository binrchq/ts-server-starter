/**
 * 消息队列工厂。memory/redis 已实现；rabbitmq/kafka 保留接口位，
 * 未实现时直接在启动期抛错（早失败优于运行时静默丢消息）。
 */
import type { Config } from '../../config/schema.js';
import type { Logger } from '../../shared/logger.js';
import { createRedisClient } from '../redis/client.js';
import { MemoryMessageQueue } from './memory-mq.js';
import { RedisMessageQueue } from './redis-mq.js';
import type { MessageQueue } from './types.js';

export * from './types.js';
export { MemoryMessageQueue } from './memory-mq.js';
export { RedisMessageQueue } from './redis-mq.js';

export interface CreateMqResult {
  mq: MessageQueue;
  close: () => Promise<void>;
}

export async function createMessageQueue(cfg: Config, logger: Logger): Promise<CreateMqResult> {
  const log = logger.component('mq');

  if (cfg.mq.driver === 'memory') {
    const mq = new MemoryMessageQueue(logger);
    return { mq, close: () => mq.close() };
  }

  if (cfg.mq.driver === 'redis') {
    const redis = createRedisClient({ config: cfg.redis, keyPrefix: cfg.mq.topicPrefix });
    await redis.ping();
    log.info('redis mq ready', { host: cfg.redis.host, port: cfg.redis.port });
    const mq = new RedisMessageQueue(redis, cfg.mq.topicPrefix, logger);
    return {
      mq,
      close: async () => {
        await mq.close();
        await redis.close();
      },
    };
  }

  throw new Error(
    `mq driver "${cfg.mq.driver}" is declared but not implemented. ` +
      'Implement it in src/infra/messaging/ or switch to memory/redis.',
  );
}
