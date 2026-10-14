/**
 * 按路由层区分 CORS 策略（对应 go-starter 的 ROUTERS.md 矩阵）。
 *
 *   outer   —— 浏览器前端，白名单 + 允许携带 Cookie
 *   admin   —— 管理台，白名单更窄，同样允许 Cookie
 *   openapi —— 第三方合作方，允许任意来源但 **禁止** 携带 Cookie
 *              （用 API Key / 签名鉴权，绝不能把浏览器凭据借给外部源）
 *   inner   —— 服务间调用，浏览器不参与，完全关闭 CORS
 *   metrics —— 抓取端，关闭 CORS
 */
import cors from 'cors';
import type { RequestHandler } from 'express';
import type { Config } from '../config/schema.js';
import { ForbiddenError } from '../shared/errors.js';

export type RouterLayer = 'outer' | 'admin' | 'inner' | 'openapi' | 'metrics';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Request-Id',
  'X-Api-Key',
  'X-Signature',
  'X-Timestamp',
  'Accept',
  'Origin',
] as const;
const EXPOSED_HEADERS = ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'] as const;

const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * outer / admin 的来源校验。
 *
 * 三条规则，按优先级：
 *   1. 没有 Origin 头 → 放行（同源请求、curl、服务间调用都不带 Origin）
 *   2. 命中白名单 → 放行
 *   3. 非生产环境 + localhost/127.0.0.1（任意端口）→ 放行
 *
 * 生产环境白名单为空时**全部拒绝**（fail-closed）：宁可前端报跨域错误，
 * 也不要静默地对所有来源开放。启动时 assertCorsConfigured() 会额外告警。
 */
function createOriginChecker(cfg: Config): (origin: string | undefined) => boolean {
  const origins = cfg.security.allowedOrigins;
  const isDev = cfg.environment !== 'prod';
  return (origin) => {
    if (!origin) return true;
    if (origins.includes(origin)) return true;
    if (isDev && DEV_ORIGIN.test(origin)) return true;
    return false;
  };
}

export function corsForLayer(layer: RouterLayer, cfg: Config): RequestHandler {
  if (layer === 'inner' || layer === 'metrics') {
    // 不注册 CORS 中间件，浏览器跨域请求会因缺少响应头而自然失败
    return (_req, _res, next) => next();
  }

  // openapi 面向不可枚举的第三方来源，因此放开 Origin ——
  // 但**必须**同时 credentials=false：一旦带上 Cookie，
  // 任何网站都能借用访客的登录态调用我们的接口。
  // 这一层的安全边界是 API Key，不是 Origin。
  if (layer === 'openapi') {
    return cors({
      origin: '*',
      credentials: false,
      methods: [...METHODS],
      allowedHeaders: [...ALLOWED_HEADERS],
      exposedHeaders: [...EXPOSED_HEADERS],
      maxAge: 12 * 3600,
      optionsSuccessStatus: 204,
    });
  }

  const isAllowed = createOriginChecker(cfg);

  return cors({
    origin(origin, callback) {
      // 回 false 即可：CORS 层不该抛业务错误码（浏览器本来也读不到响应体）
      callback(null, isAllowed(origin));
    },
    credentials: true,
    methods: [...METHODS],
    allowedHeaders: [...ALLOWED_HEADERS],
    exposedHeaders: [...EXPOSED_HEADERS],
    maxAge: 12 * 3600,
    optionsSuccessStatus: 204,
  });
}

/** 生产环境启动自检：白名单为空等于对全世界开放，必须显式提醒 */
export function assertCorsConfigured(cfg: Config): string | null {
  if (cfg.environment !== 'prod') return null;
  if (cfg.security.allowedOrigins.length === 0) {
    return 'security.allowed_origins is empty in production — CORS is effectively open to every origin.';
  }
  if (cfg.security.allowedOrigins.includes('*')) {
    return 'security.allowed_origins contains "*" in production — use an explicit allowlist.';
  }
  return null;
}

export { ForbiddenError };
