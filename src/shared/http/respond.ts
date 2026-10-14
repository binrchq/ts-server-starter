/**
 * 统一响应体。所有接口都返回 { success, data } 或 { success, error }，
 * 前端只需要一套解析逻辑，避免「有的接口裸返回数组、有的包一层」这种历史债。
 */
import type { Response } from 'express';
import type { AppError } from '../errors.js';
import { toAppError } from '../errors.js';
import { getRequestContext } from '../request-context.js';

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  /**
   * 请求 id。每个错误响应都带上它 ——
   * 客户端反馈问题时贴一段 JSON，就能在日志里精确定位，不用靠时间戳猜。
   */
  requestId?: string;
  /** 仅 429 出现：建议等待多少秒后重试（与 Retry-After 头一致） */
  retryAfter?: number;
  details?: unknown;
}

export interface ApiFailure {
  success: false;
  error: ApiErrorBody;
}

/**
 * 统一构造错误体。
 * requestId 从 AsyncLocalStorage 取，因此调用方不需要把 req 透传进来。
 */
export function failureBody(
  error: AppError,
  extra: { details?: unknown; retryAfter?: number; message?: string } = {},
): ApiFailure {
  const requestId = getRequestContext()?.requestId;
  return {
    success: false,
    error: {
      code: error.code,
      // message 可覆盖：未暴露的错误对外统一成 "Internal server error."，细节只进日志
      message: extra.message ?? error.message,
      ...(requestId ? { requestId } : {}),
      ...(extra.retryAfter !== undefined ? { retryAfter: extra.retryAfter } : {}),
      ...(extra.details !== undefined ? { details: extra.details } : {}),
    },
  };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>): Response {
  return res.json({ success: true, data, ...(meta ? { meta } : {}) } satisfies ApiSuccess<T>);
}

export function created<T>(res: Response, data: T): Response {
  return res.status(201).json({ success: true, data } satisfies ApiSuccess<T>);
}

export function noContent(res: Response): Response {
  return res.status(204).end();
}

export function paginated<T>(res: Response, page: Paginated<T>): Response {
  return res.json({ success: true, data: page } satisfies ApiSuccess<Paginated<T>>);
}

export function fail(res: Response, error: unknown, extra: { details?: unknown; retryAfter?: number } = {}): Response {
  const appError: AppError = toAppError(error);
  if (res.headersSent) {
    // SSE / 流式响应已经开始，无法再改状态码，只能断开连接
    return res.end();
  }
  return res.status(appError.statusCode).json(failureBody(appError, extra));
}
