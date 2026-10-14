/**
 * 访问日志。
 *
 * 只记录「可安全落盘」的字段：方法、路径、状态、耗时、UA。
 * 查询串可能含 token/email，因此记录前先脱敏；请求体完全不记。
 */
import type { RequestHandler } from 'express';
import type { Logger } from '../../shared/logger.js';
import type { Redactor } from '../../security/redact.js';
import { redactHeaders } from '../../security/redact.js';

export interface RequestLoggerOptions {
  logger: Logger;
  redact: Redactor;
  /** 不记录日志的路径前缀（健康检查/指标） */
  ignorePaths?: string[];
  /** 慢请求阈值，超过则升级为 warn */
  slowMs?: number;
}

export function requestLogger(options: RequestLoggerOptions): RequestHandler {
  const ignorePaths = options.ignorePaths ?? ['/health', '/metrics', '/readyz', '/livez'];
  const slowMs = options.slowMs ?? 1000;

  return (req, res, next) => {
    if (ignorePaths.some((prefix) => req.path.startsWith(prefix))) return next();

    const startedAt = process.hrtime.bigint();
    const log = (req.requestLogger ?? options.logger).child({
      method: req.method,
      path: req.path,
      requestId: req.requestId,
    });

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields: Record<string, unknown> = {
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ip: req.ip,
        userAgent: req.header('user-agent'),
        query: req.query && Object.keys(req.query).length > 0 ? options.redact(req.query) : undefined,
        headers: redactHeaders(req.headers),
      };

      if (res.statusCode >= 500) log.error(undefined, 'request failed', fields);
      else if (res.statusCode >= 400) log.warn('request rejected', fields);
      else if (durationMs >= slowMs) log.warn('slow request', fields);
      else log.info('request', fields);
    });

    next();
  };
}
