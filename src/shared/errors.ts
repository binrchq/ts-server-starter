/**
 * 统一错误体系。
 *
 * 约定：只有 AppError 的子类会被 HTTP 层原样返回给客户端（statusCode + code），
 * 其它任何异常一律降级成 500 INTERNAL_ERROR，且生产环境不暴露 message/stack。
 * 这样「业务可预期错误」与「程序缺陷」在传输层就分开了。
 */

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UPSTREAM_ERROR',
  'SERVICE_UNAVAILABLE',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorOptions {
  statusCode?: number;
  code?: ErrorCode;
  /** 附加信息（字段级校验错误等），会原样返回给客户端 */
  details?: unknown;
  /** 是否可安全暴露 message 给客户端 */
  expose?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.details = options.details;
    this.expose = options.expose ?? this.statusCode < 500;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return {
      code: this.code,
      message: this.expose ? this.message : 'Internal server error.',
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed.', details?: unknown) {
    super(message, { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(message, { statusCode: 401, code: 'UNAUTHORIZED' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super(message, { statusCode: 403, code: 'FORBIDDEN' });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource does not exist.', details?: unknown) {
    super(message, { statusCode: 404, code: 'NOT_FOUND', details });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'The resource already exists.') {
    super(message, { statusCode: 409, code: 'CONFLICT' });
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests. Please try again later.', details?: unknown) {
    super(message, { statusCode: 429, code: 'RATE_LIMITED', details });
  }
}

export class UpstreamError extends AppError {
  constructor(message = 'Upstream dependency failed.', cause?: unknown) {
    super(message, { statusCode: 502, code: 'UPSTREAM_ERROR', cause });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable.', details?: unknown) {
    super(message, { statusCode: 503, code: 'SERVICE_UNAVAILABLE', details });
  }
}

export class NotImplementedError extends AppError {
  constructor(message = 'This capability is not implemented yet.') {
    super(message, { statusCode: 501, code: 'NOT_IMPLEMENTED' });
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** 把任意异常收敛成 AppError（用于错误中间件的最后一道兜底） */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  const wrapped = new AppError(err instanceof Error ? err.message : String(err), {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    expose: false,
    cause: err,
  });
  if (err instanceof Error && err.stack) wrapped.stack = err.stack;
  return wrapped;
}
