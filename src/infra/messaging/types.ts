/**
 * 消息队列抽象。
 *
 * 语义边界（写清楚，避免用错）：
 *  - memory：仅进程内，重启即丢，用于本地开发与解耦内部流程
 *  - redis ：Pub/Sub，**至多一次**，订阅者离线期间的消息永久丢失
 *  - 需要「至少一次 + 消费者组」请接 rabbitmq/kafka（driver 已预留）
 * 所以：关键业务（支付、发放权益）不要走 redis 驱动。
 */
export interface Message<T = unknown> {
  id: string;
  topic: string;
  payload: T;
  headers: Record<string, string>;
  timestamp: Date;
  /**
   * 投递序号，**从 1 开始**：1 表示首次投递，2 表示第 1 次重试……
   * 之所以不用 0 起，是因为它会被直接写进日志和告警，
   * 看到 "attempt: 0" 时无法判断是「还没投递」还是「首次投递」。
   */
  attempt: number;
}

export type MessageHandler<T = unknown> = (message: Message<T>) => Promise<void> | void;

export interface SubscribeOptions {
  /** 消费者组 / 队列名。redis 驱动忽略该字段（Pub/Sub 无组概念） */
  group?: string;
  /** 处理失败时的最大重试次数，默认 0（不重试） */
  maxRetries?: number;
  /** 并发度，默认 1（顺序处理，保证同 key 有序） */
  concurrency?: number;
}

export interface Unsubscribe {
  (): Promise<void>;
}

export interface MessageQueue {
  readonly driver: 'memory' | 'redis' | 'rabbitmq' | 'kafka';
  publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void>;
  subscribe<T>(topic: string, handler: MessageHandler<T>, options?: SubscribeOptions): Promise<Unsubscribe>;
  readonly topics: string[];
  close(): Promise<void>;
}
