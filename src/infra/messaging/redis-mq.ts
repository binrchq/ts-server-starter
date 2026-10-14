/**
 * Redis Pub/Sub 消息队列。
 *
 * 重要限制（务必知悉）：Redis Pub/Sub 是「至多一次」投递 ——
 * 订阅者离线期间的消息会永久丢失，没有 ack，没有重投。
 * 因此只适合通知/缓存失效这类可容忍丢失的场景。
 * 需要可靠投递请换 Kafka/RabbitMQ。
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from '../../shared/logger.js';
import { getLogger } from '../../shared/logger.js';
import type { RedisHandle } from '../redis/client.js';
import type { Message, MessageHandler, MessageQueue, SubscribeOptions, Unsubscribe } from './types.js';

export class RedisMessageQueue implements MessageQueue {
  readonly driver = 'redis' as const;

  private readonly subscriber: Redis;
  private readonly logger: Logger;
  /** topic -> 原始监听器集合 */
  private readonly handlers = new Map<string, Set<(raw: string) => void>>();
  /** channel -> 原始监听器集合（供单例 message 事件分发） */
  private readonly listenersByChannel = new Map<string, Set<(raw: string) => void>>();

  constructor(
    private readonly redis: RedisHandle,
    private readonly topicPrefix = '',
    logger: Logger = getLogger(),
  ) {
    this.logger = logger.component('mq-redis');
    // 订阅必须用独立连接：连接进入 subscribe 模式后无法执行普通命令
    this.subscriber = redis.client.duplicate();
    this.subscriber.on('error', () => {});
    // 单例监听器：所有订阅共用，避免每次 subscribe 都往 EventEmitter 上挂
    // 一个永不释放的闭包（订阅数一多就是内存泄漏）。
    this.subscriber.on('message', (channel: string, raw: string) => {
      const listeners = this.listenersByChannel.get(channel);
      if (!listeners) return;
      for (const listener of listeners) listener(raw);
    });
  }

  get topics(): string[] {
    return [...this.handlers.keys()];
  }

  private channel(topic: string): string {
    return `${this.topicPrefix}${topic}`;
  }

  async publish<T>(topic: string, payload: T, headers: Record<string, string> = {}): Promise<void> {
    const message: Message<T> = {
      id: randomUUID(),
      topic,
      payload,
      headers,
      timestamp: new Date(),
      attempt: 1,
    };
    await this.redis.client.publish(this.channel(topic), JSON.stringify(message));
  }

  async subscribe<T>(topic: string, handler: MessageHandler<T>, _options: SubscribeOptions = {}): Promise<Unsubscribe> {
    const channel = this.channel(topic);
    const listener = (raw: string) => {
      void (async () => {
        try {
          const message = JSON.parse(raw) as Message<T>;
          await handler(message);
        } catch (err) {
          this.logger.error(err, 'redis message handler failed', { topic });
        }
      })();
    };

    let topicListeners = this.handlers.get(topic);
    let channelListeners = this.listenersByChannel.get(channel);
    if (!topicListeners || !channelListeners) {
      topicListeners = new Set();
      channelListeners = new Set();
      this.handlers.set(topic, topicListeners);
      this.listenersByChannel.set(channel, channelListeners);
      await this.subscriber.subscribe(channel);
      this.logger.debug('subscribed', { topic, channel });
    }
    topicListeners.add(listener);
    channelListeners.add(listener);

    return async () => {
      const currentTopic = this.handlers.get(topic);
      const currentChannel = this.listenersByChannel.get(channel);
      currentTopic?.delete(listener);
      currentChannel?.delete(listener);
      if ((currentTopic?.size ?? 0) === 0) {
        this.handlers.delete(topic);
        this.listenersByChannel.delete(channel);
        await this.subscriber.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.listenersByChannel.clear();
    try {
      await this.subscriber.quit();
    } catch {
      this.subscriber.disconnect();
    }
  }
}
