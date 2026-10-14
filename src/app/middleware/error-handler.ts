/**
 * 全局错误处理（必须最后注册）。
 *
 * 三件事：
 *  1. 把任意异常收敛成 AppError，业务错误（4xx）按原样返回
 *  2. 日志分级：4xx = warn（客户端问题/攻击特征），5xx = error（我们的问题）
 *  3. 生产环境绝不回传 message/stack（信息泄露），只留 requestId 供对账
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from '../../shared/logger.js';
import type { Redactor } from '../../security/redact.js';
import { AppError, isAppError, toAppError } from '../../shared/errors.js';
import type { ApiFailure } from '../../shared/http/respond.js';
import { failureBody } from '../../shared/http/respond.js';

export interface ErrorHandlerOptions {
  logger: Logger;
  redact: Redactor;
  /** 是否把内部错误细节返回给客户端（仅开发环境开启） */
  includeDetails?: boolean;
}

/** 把 express/body-parser 抛出的技术性错误翻译成语义化 AppError */
export function normalizeError(err: unknown): AppError {
  if (isAppError(err)) return err;

  // body-parser 的 JSON 解析失败抛的是 SyntaxError，且带 status=400 / type=entity.parse.failed。
  // 先按 instanceof 收窄，再读商业字段 —— 顺序反了 TS 会认为 SyntaxError 上没有 status。
  if (err instanceof SyntaxError && (err as SyntaxError & { status?: number }).status === 400) {
    return new AppError('Malformed JSON body.', { statusCode: 400, code: 'VALIDATION_ERROR' });
  }

  const candidate = err as { type?: string; status?: number; statusCode?: number; message?: string };
  if (candidate?.type === 'entity.too.large') {
    return new AppError('Request body too large.', { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
  }
  if (candidate?.type === 'entity.parse.failed') {
    return new AppError('Malformed request body.', { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  return toAppError(err);
}

export function errorHandler(options: ErrorHandlerOptions): ErrorRequestHandler {
  const log = options.logger.component('http-error');

  return (err, req, res, _next) => {
    const appError = normalizeError(err);
    const fields = {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: appError.statusCode,
      code: appError.code,
      ip: req.ip,
      userId: req.user?.userId,
    };

    if (appError.statusCode >= 500) {
      log.error(err, 'unhandled request error', { ...fields, detail: options.redact(appError.details) });
    } else {
      log.warn('request error', { ...fields, detail: options.redact(appError.details) });
    }

    // 统一走 failureBody：requestId 自动带上，形状与 fail() 完全一致。
    // 未标记 expose 的错误只对外说 "Internal server error."，
    // 细节（栈）仅在非生产环境回传，避免把内部结构泄漏给攻击者。
    const details = appError.expose
      ? appError.details
      : options.includeDetails
        ? { message: (err as Error)?.message, stack: (err as Error)?.stack?.split('\n').slice(0, 5) }
        : undefined;

    const body: ApiFailure = failureBody(appError, {
      ...(appError.expose ? {} : { message: 'Internal server error.' }),
      ...(details !== undefined ? { details } : {}),
    });

    if (res.headersSent) {
      // SSE 等流式响应：无法再改状态码，只能结束
      return res.end();
    }
    res.status(appError.statusCode).json(body);
  };
}

/** 404：放在所有路由之后 */
export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    const error = new AppError(`Route ${req.method} ${req.path} not found.`, {
      statusCode: 404,
      code: 'NOT_FOUND',
    });
    res.status(404).json(failureBody(error));
  };
}
