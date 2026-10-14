/**
 * 缓存抽象。业务只依赖这个接口，redis/memory 由配置切换。
 */
export interface Cache {
  readonly driver: 'memory' | 'redis';
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  del(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  incr(key: string, by?: number): Promise<number>;
  /**
   * 读缓存，miss 则由 producer 计算并回填。
   * 实现必须保证「同一个 key 的并发 miss 只计算一次」（防击穿）。
   */
  remember<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T>;
  /** 按前缀删除（务必带前缀，避免误删） */
  deleteByPrefix(prefix: string): Promise<number>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
