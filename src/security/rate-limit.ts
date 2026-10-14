/**
 * 分层限流。
 *
 * 三档策略：
 *   global —— 每个 IP/用户 的兜底额度
 *   auth   —— 登录/注册/刷新，抗撞库，额度极小
 *   strict —— 昂贵操作（AI 生成、导出），按用户维度而非 IP（更公平也更难绕过）
 *
 * keyGenerator 优先用已认证的 userId：NAT 后的多个用户不会被互相拖累，
 * 攻击者换 IP 也没用。
 */
import { rateLimit, type RateLimitRequestHandler, type Store } from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config/schema.js';
import { getRequestContext } from '../shared/request-context.js';
import type { Auditor } from './audit.js';
import { AuditAction } from './audit.js';

export interface RateLimiters {
  global: RateLimitRequestHandler;
  auth: RateLimitRequestHandler;
  /** 按策略名缓存，避免每个路由重复构造 */
  strict(policy: string, max?: number, windowMs?: number): RateLimitRequestHandler;
}

export interface RateLimitOptions {
  /** 外部存储（Redis 等），默认进程内内存 */
  store?: Store;
  auditor?: Auditor;
}

function identityKey(req: Request): string {
  const userId = getRequestContext()?.userId;
  if (userId) return `user:${userId}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

export function createRateLimiters(cfg: Config, options: RateLimitOptions = {}): RateLimiters {
  const { windowMs, max, authMax } = cfg.security.rateLimit;
  const cache = new Map<string, RateLimitRequestHandler>();

  const handleExceeded = (req: Request) => {
    options.auditor?.record({
      action: AuditAction.RateLimited,
      outcome: 'denied',
      resource: `${req.method} ${req.baseUrl}${req.path}`,
      ip: req.ip,
    });
  };

  const build = (limit: number, window: number, message: string): RateLimitRequestHandler =>
    rateLimit({
      windowMs: window,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: identityKey,
      store: options.store,
      handler: (req, res, _next, opts) => {
        handleExceeded(req);
        // Retry-After 由 express-rate-limit 写进响应头；这里同步一份到响应体。
        // 重试队列/移动端常常只看 body，缺了它就只能盲目退避。
        const retryAfter = Number(res.getHeader('Retry-After') ?? 0);
        res.status(opts.statusCode).json({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message,
            ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
          },
        });
      },
      // trust proxy 由 app 层显式设置；这里不重复校验，否则
      // trustProxy=true 会直接抛错，反而让开发环境起不来。
      validate: { trustProxy: false, xForwardedForHeader: false },
    });

  const global = build(max, windowMs, 'Too many requests. Please slow down.');

  const auth = build(authMax, windowMs, 'Too many authentication attempts. Please wait before retrying.');

  // RateLimitRequestHandler 带有 resetKey/getKey 等属性，纯函数签名不匹配，
  // 因此显式断言：关闭限流时这些附加方法本来就不该被调用。
  const disabled = ((_req: Request, _res: Response, next: NextFunction) =>
    next()) as unknown as RateLimitRequestHandler;

  if (!cfg.security.rateLimit.enabled) {
    return { global: disabled, auth: disabled, strict: () => disabled };
  }

  return {
    global,
    auth,
    strict(policy, strictMax = Math.max(5, Math.floor(max / 10)), strictWindow = windowMs) {
      const key = `${policy}:${strictMax}:${strictWindow}`;
      let limiter = cache.get(key);
      if (!limiter) {
        limiter = build(strictMax, strictWindow, `Too many requests for "${policy}". Please try again later.`);
        cache.set(key, limiter);
      }
      return limiter;
    },
  };
}
