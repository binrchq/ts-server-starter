/**
 * 安全响应头。
 *
 * 分两类受众：
 *  - API 端口（outer 的 /api、inner、admin、openapi）：内容永远是 JSON/SSE，
 *    所以 CSP 用最严格的 `default-src 'none'`，并禁止被 iframe 嵌入。
 *  - 文档/控制台端口（例如 admin 的 /docs）：需要放开 script/style。
 */
import helmet from 'helmet';
import type { RequestHandler } from 'express';

export type HeaderProfile = 'api' | 'docs';

export interface HeaderOptions {
  /** 仅在确定走 HTTPS 时开启 HSTS，否则本地开发会被浏览器强制跳转 */
  enableHsts: boolean;
  profile?: HeaderProfile;
}

export function securityHeaders(options: HeaderOptions): RequestHandler {
  const profile = options.profile ?? 'api';

  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives:
        profile === 'api'
          ? {
              'default-src': ["'none'"],
              'frame-ancestors': ["'none'"],
              'base-uri': ["'none'"],
              'form-action': ["'none'"],
            }
          : {
              'default-src': ["'self'"],
              'script-src': ["'self'", "'unsafe-inline'"],
              'style-src': ["'self'", "'unsafe-inline'"],
              'img-src': ["'self'", 'data:', 'https:'],
              'connect-src': ["'self'"],
              'frame-ancestors': ["'none'"],
              'object-src': ["'none'"],
            },
    },
    // 只在 TLS 终止可信时开启，避免把 http 开发环境锁死
    hsts: options.enableHsts ? { maxAge: 31_536_000, includeSubDomains: true, preload: false } : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    // 注意：helmet v7 起移除了 contentSecurityPolicyReportOnly，
    // 「只报告不拦截」的 CSP 需要手动 res.setHeader 实现，本模板不需要。
    dnsPrefetchControl: { allow: false },
    originAgentCluster: true,
    xssFilter: true,
    noSniff: true,
    frameguard: { action: 'deny' },
  });
}
