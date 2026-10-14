/**
 * 安全子系统入口 —— 把所有安全中间件按路由层组装好，供 app 层直接挂载。
 */
import type { RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import type { Config } from '../config/schema.js';
import type { Logger } from '../shared/logger.js';
import { securityHeaders, type HeaderProfile } from './headers.js';
import { corsForLayer, type RouterLayer } from './cors.js';
import { createRateLimiters, type RateLimiters } from './rate-limit.js';
import { Auditor, createLoggerSink, type AuditSink } from './audit.js';
import { createRedactor, type Redactor } from './redact.js';

export * from './audit.js';
export * from './cors.js';
export * from './headers.js';
export * from './rate-limit.js';
export * from './redact.js';
export * from './secrets.js';

export interface SecurityStack {
  auditor: Auditor;
  redact: Redactor;
  limiters: RateLimiters;
  /** 给某个路由层组装 [响应头, CORS, 限流] */
  forLayer(layer: RouterLayer, profile?: HeaderProfile): RequestHandler[];
  /** 追加审计 sink（例如落库） */
  addAuditSink(sink: AuditSink): void;
}

export interface SecurityStackOptions {
  /** HTTPS 环境下才开 HSTS */
  https: boolean;
  extraAuditSinks?: AuditSink[];
  /** 外部限流存储（Redis 等），默认进程内内存 */
  rateLimitStore?: Store;
}

export function createSecurityStack(cfg: Config, logger: Logger, options: SecurityStackOptions): SecurityStack {
  const auditor = new Auditor([createLoggerSink(logger), ...(options.extraAuditSinks ?? [])], cfg.security.auditLog);
  const redact = createRedactor({ keys: cfg.security.redactKeys });
  const limiters = createRateLimiters(cfg, { store: options.rateLimitStore, auditor });

  return {
    auditor,
    redact,
    limiters,
    addAuditSink: (sink) => auditor.addSink(sink),
    forLayer(layer, profile = 'api') {
      return [securityHeaders({ enableHsts: options.https, profile }), corsForLayer(layer, cfg), limiters.global];
    },
  };
}
