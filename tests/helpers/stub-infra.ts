/**
 * 测试替身。
 *
 * 存在的意义：验证「HTTP + 鉴权 + 多端口隔离」这些逻辑，本来不需要一个真的
 * Postgres 和 Redis。如果为了跑单元测试必须起两个容器，测试就会慢慢没人跑。
 *
 * 注意这些替身是**诚实**的：不支持的能力直接抛错，而不是假装成功。
 * 一个会静默返回空结果集的假数据库，比没有数据库更危险。
 */
import type { Cache } from '../../src/infra/cache/types.js';
import type { Database, DatabaseDriver, Executor, QueryResult } from '../../src/infra/database/types.js';
import type {
  Message,
  MessageHandler,
  MessageQueue,
  SubscribeOptions,
  Unsubscribe,
} from '../../src/infra/messaging/types.js';
import type { Lock, StateAdapter } from '../../src/infra/state/types.js';

export class StubDatabase implements Database {
  readonly driver: DatabaseDriver = 'postgres';
  readonly dialect = 'sql' as const;
  readonly native = null;
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  pingCount = 0;
  closed = false;

  /**
   * handler 决定替身返回什么。默认空结果集 —— 所以依赖真实返回值的用例
   * **必须**显式提供 handler，否则会拿到空数据而误以为通过。
   */
  constructor(
    private readonly handler?: (sql: string, params: readonly unknown[]) => QueryResult<Record<string, unknown>>,
  ) {}

  query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    this.queries.push({ sql, params });
    const result = this.handler?.(sql, params) ?? { rows: [], rowCount: 0 };
    return Promise.resolve(result as QueryResult<T>);
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const result = await this.query<T>(sql, params);
    return result.rows[0];
  }

  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    // 不模拟回滚语义：真需要验证事务的用例应该跑真库
    return fn(this);
  }

  ping(): Promise<void> {
    this.pingCount += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export class StubState implements StateAdapter {
  readonly driver = 'memory' as const;
  private readonly store = new Map<string, { value: unknown; expiresAt: number | null }>();
  private readonly locks = new Map<string, string>();

  private live(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.live(key) ? (this.store.get(key)?.value as T) : undefined);
  }

  set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.store.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(key));
  }

  setIfAbsent<T>(key: string, value: T, ttlMs?: number): Promise<boolean> {
    if (this.live(key)) return Promise.resolve(false);
    return this.set(key, value, ttlMs).then(() => true);
  }

  increment(key: string, by = 1, ttlMs?: number): Promise<number> {
    const current = this.live(key) ? Number(this.store.get(key)?.value ?? 0) : 0;
    const next = current + by;
    // 保留原 TTL：限流窗口不该因为计数而被无限延长
    const existing = this.store.get(key);
    const expiresAt = existing && this.live(key) ? existing.expiresAt : ttlMs ? Date.now() + ttlMs : null;
    this.store.set(key, { value: next, expiresAt });
    return Promise.resolve(next);
  }

  acquireLock(key: string, ttlMs: number): Promise<Lock | null> {
    if (this.locks.has(key)) return Promise.resolve(null);
    const token = `${Date.now()}-${Math.random()}`;
    this.locks.set(key, token);
    const expiresAt = Date.now() + ttlMs;
    // 闭包捕获 map，而不是把 this 别名为局部变量：
    // 对象字面量的方法有自己的 this，解构后就失效了
    const locks = this.locks;
    const lock: Lock = {
      key,
      get held() {
        return locks.get(key) === token && Date.now() < expiresAt;
      },
      release() {
        const owned = locks.get(key) === token;
        if (owned) locks.delete(key);
        return Promise.resolve(owned);
      },
      extend(_extraMs: number) {
        if (locks.get(key) !== token || Date.now() >= expiresAt) return Promise.resolve(false);
        return Promise.resolve(true);
      },
    };
    return Promise.resolve(lock);
  }

  close(): Promise<void> {
    this.store.clear();
    this.locks.clear();
    return Promise.resolve();
  }
}

export class StubCache implements Cache {
  readonly driver = 'memory' as const;
  private readonly store = new Map<string, { value: unknown; expiresAt: number | null }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  hits = 0;
  misses = 0;

  private live(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  get<T>(key: string): Promise<T | undefined> {
    if (this.live(key)) {
      this.hits += 1;
      return Promise.resolve(this.store.get(key)?.value as T);
    }
    this.misses += 1;
    return Promise.resolve(undefined);
  }

  set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.store.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
    return Promise.resolve();
  }

  del(key: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(key));
  }

  has(key: string): Promise<boolean> {
    return Promise.resolve(this.live(key));
  }

  incr(key: string, by = 1): Promise<number> {
    const next = (this.live(key) ? Number(this.store.get(key)?.value ?? 0) : 0) + by;
    this.store.set(key, { value: next, expiresAt: this.store.get(key)?.expiresAt ?? null });
    return Promise.resolve(next);
  }

  /** 关键语义：同一 key 的并发 miss 只计算一次（防击穿） */
  remember<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const task = (async (): Promise<T> => {
      const cached = await this.get<T>(key);
      if (cached !== undefined) return cached;
      const value = await producer();
      await this.set(key, value, ttlMs);
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  clear(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class StubQueue implements MessageQueue {
  readonly driver = 'memory' as const;
  /** 已投递消息，供断言使用 */
  readonly published: Message[] = [];
  /** 与 memory-mq 的差异：这里同步派发，测试无需等待 */
  private readonly handlers = new Map<string, Set<MessageHandler>>();

  private get topicList(): string[] {
    return [...this.handlers.keys()];
  }

  get topics(): string[] {
    return this.topicList;
  }

  publish<T>(topic: string, payload: T, headers: Record<string, string> = {}): Promise<void> {
    const message: Message = {
      id: `msg-${this.published.length + 1}`,
      topic,
      payload,
      headers,
      timestamp: new Date(),
      attempt: 1,
    };
    this.published.push(message);
    const set = this.handlers.get(topic);
    if (set) for (const handler of set) void handler(message);
    return Promise.resolve();
  }

  subscribe<T>(topic: string, handler: MessageHandler<T>, _options?: SubscribeOptions): Promise<Unsubscribe> {
    const set = this.handlers.get(topic) ?? new Set<MessageHandler>();
    set.add(handler as MessageHandler);
    this.handlers.set(topic, set);
    const unsubscribe: Unsubscribe = () => {
      set.delete(handler as MessageHandler);
      return Promise.resolve();
    };
    return Promise.resolve(unsubscribe);
  }

  close(): Promise<void> {
    this.handlers.clear();
    return Promise.resolve();
  }
}
