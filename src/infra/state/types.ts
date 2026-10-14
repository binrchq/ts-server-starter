/**
 * 分布式状态抽象。
 *
 * 用途：跨实例的「只有一个节点能做事」场景 —— 定时任务抢占、
 * 幂等去重、限流计数、一次性 token。
 *
 * 说清能力差异，避免误用：
 *   memory：单进程有效，多实例下锁形同虚设（仅开发环境）
 *   redis ：SET NX PX + Lua CAS 释放，多实例安全（生产常用这个）
 *   etcd  ：版本号 CAS + 原生租约，强一致；适合 leader election / fencing token
 */
export interface Lock {
  readonly key: string;
  /** 是否仍持有（可能因 TTL 过期已丢失） */
  readonly held: boolean;
  /** 释放锁；只有持有者能释放（Lua 比对 token） */
  release(): Promise<boolean>;
  /** 续期，返回是否续期成功 */
  extend(ttlMs: number): Promise<boolean>;
}

export interface StateAdapter {
  readonly driver: 'memory' | 'redis' | 'etcd';
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** SET NX：返回 true 表示本次写入成功（键此前不存在） */
  setIfAbsent<T>(key: string, value: T, ttlMs?: number): Promise<boolean>;
  /** 原子自增（限流计数用） */
  increment(key: string, by?: number, ttlMs?: number): Promise<number>;
  acquireLock(key: string, ttlMs: number): Promise<Lock | null>;
  close(): Promise<void>;
}
