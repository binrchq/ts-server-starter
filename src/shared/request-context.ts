/**
 * 请求级上下文。
 *
 * Go 版本靠 context.Context 一路透传；Node 里等价的惯用做法是
 * AsyncLocalStorage —— 一次 enterWith，之后链路上任何位置都能读到
 * requestId / userId / 请求级 logger，不必再往每个函数签名里塞参数。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from './logger.js';
import { getLogger } from './logger.js';

export interface RequestContext {
  requestId: string;
  /** 认证后由 authenticate 中间件写入 */
  userId?: string;
  /** 调用方 IP（已按 trust proxy 规则解析） */
  ip?: string;
  /**
   * User-Agent。审计事件会自动带上它 ——
   * 事后追查时「同一个 IP 换了几个 UA」「某个 UA 在 burst 尝试登录」
   * 是很强的信号，丢了就补不回来。
   */
  userAgent?: string;
  /** 该请求所属的路由层：outer | inner | admin | openapi */
  layer?: string;
  /** 请求级 logger，自带 requestId 字段 */
  logger: Logger;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** 取当前请求的 logger；不在请求上下文里时回退全局 logger */
export function requestLogger(): Logger {
  return storage.getStore()?.logger ?? getLogger();
}

export function currentUserId(): string | undefined {
  return storage.getStore()?.userId;
}

/** 把已登录用户写回上下文（认证中间件调用） */
export function setCurrentUserId(userId: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.userId = userId;
}
