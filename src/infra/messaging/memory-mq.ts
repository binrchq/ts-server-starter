/**
 * 进程内消息队列。
 * 支持并发度、失败重试与退避，语义尽量贴近真实 broker，
 * 这样本地开发跑通、切到 Kafka 不会出现行为差异。
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '../../shared/logger.js';
import { getLogger } from '../../shared/logger.js';
import type { Message, MessageHandler, MessageQueue, SubscribeOptions, Unsubscribe } from './types.js';

interface Subscription {
  id: string;
  topic: string;
  handler: MessageHandler<never>;
  options: Required<Pick<SubscribeOptions, 'maxRetries' | 'concurrency'>>;
  active: number;
  queue: Message<never>[];
}

export class MemoryMessageQueue implements MessageQueue {
  readonly driver = 'memory' as const;

  private readonly subscriptions = new Map<string, Subscription>();
  private readonly logger: Logger;
  private closed = false;

  constructor(logger: Logger = getLogger()) {
    this.logger = logger.component('mq-memory');
  }

  get topics(): string[] {
    return [...new Set([...this.subscriptions.values()].map((s) => s.topic))];
  }

  async publish<T>(topic: string, payload: T, headers: Record<string, string> = {}): Promise<void> {
    if (this.closed) throw new Error('message queue is closed');
    const message: Message<T> = {
      id: randomUUID(),
      topic,
      payload,
      headers,
      timestamp: new Date(),
      attempt: 1,
    };

    const targets = [...this.subscriptions.values()].filter((s) => s.topic === topic);
    if (targets.length === 0) {
      this.logger.debug('no subscriber for topic', { topic });
      return;
    }
    for (const subscription of targets) {
      subscription.queue.push(message as Message<never>);
      void this.drain(subscription);
    }
  }

  async subscribe<T>(topic: string, handler: MessageHandler<T>, options: SubscribeOptions = {}): Promise<Unsubscribe> {
    const subscription: Subscription = {
      id: randomUUID(),
      topic,
      handler: handler,
      options: {
        maxRetries: options.maxRetries ?? 0,
        concurrency: Math.max(1, options.concurrency ?? 1),
      },
      active: 0,
      queue: [],
    };
    this.subscriptions.set(subscription.id, subscription);
    this.logger.debug('subscribed', { topic, subscriptionId: subscription.id });

    return async () => {
      this.subscriptions.delete(subscription.id);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscriptions.clear();
  }

  private async drain(subscription: Subscription): Promise<void> {
    while (
      subscription.active < subscription.options.concurrency &&
      subscription.queue.length > 0 &&
      this.subscriptions.has(subscription.id)
    ) {
      const message = subscription.queue.shift();
      if (!message) return;
      subscription.active += 1;
      void this.deliver(subscription, message).finally(() => {
        subscription.active -= 1;
        void this.drain(subscription);
      });
    }
  }

  private async deliver(subscription: Subscription, message: Message<never>): Promise<void> {
    try {
      await subscription.handler(message);
    } catch (err) {
      // attempt 是「投递序号」而非「已重试次数」，所以用 <= 判断：
      // maxRetries=2 表示最多再投 2 次，总共 3 次投递
      if (message.attempt <= subscription.options.maxRetries) {
        message.attempt += 1;
        const backoff = 100 * 2 ** message.attempt;
        setTimeout(() => {
          if (!this.subscriptions.has(subscription.id)) return;
          subscription.queue.push(message);
          void this.drain(subscription);
        }, backoff).unref?.();
        this.logger.warn('message failed, will retry', {
          topic: message.topic,
          attempt: message.attempt,
          backoffMs: backoff,
        });
        return;
      }
      this.logger.error(err, 'message dropped after retries', { topic: message.topic, attempt: message.attempt });
    }
  }
}
