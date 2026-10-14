/**
 * Redis 客户端。
 *
 * 设计要点：
 *  - 惰性连接 + 显式 ping：启动时确认可用，而不是等第一个请求失败
 *  - keyPrefix 统一注入，避免多环境/多服务共用一套 Redis 时键冲突
 *  - 断线重连策略显式设置，避免默认行为在容器环境里疯狂重连打爆日志
 *  - 关闭时 quit()（等待在途命令）而不是 disconnect()
 */
import { Redis, type RedisOptions } from 'ioredis';
import type { RedisConfig } from '../../config/schema.js';

export interface RedisHandle {
  readonly client: Redis;
  /** 带前缀拼 key */
  key(...parts: string[]): string;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateRedisOptions {
  config: RedisConfig;
  /** 键前缀，例如 `0xui:dev:` */
  keyPrefix?: string;
  /** 额外 ioredis 选项 */
  extra?: RedisOptions;
}

export function createRedisClient(options: CreateRedisOptions): RedisHandle {
  const { config, keyPrefix = '' } = options;

  const base: RedisOptions = {
    host: config.host,
    port: config.port,
    db: config.database,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 200, 3000),
    reconnectOnError: (err) => /READONLY|ETIMEDOUT/.test(err.message),
    ...options.extra,
  };
  // 空密码不要传，否则 ioredis 会尝试 AUTH ""
  if (config.password) base.password = config.password;

  const client = config.url ? new Redis(config.url, { ...base, host: undefined, port: undefined }) : new Redis(base);

  // 连接期错误必须有人监听，否则 ioredis 会抛 unhandled error
  client.on('error', () => {});

  return {
    client,
    key: (...parts) => `${keyPrefix}${parts.join(':')}`,
    async ping() {
      if (client.status === 'wait') await client.connect();
      await client.ping();
    },
    async close() {
      if (client.status === 'end') return;
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}
