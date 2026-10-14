/**
 * 基于 zod 的入参校验中间件。
 *
 * 在传输层边界一次性把 body/query/params 收窄成强类型，
 * controller 里就不需要再写任何 `if (!req.body.x)`。
 * 校验失败统一抛 ValidationError（400 + 字段级 details）。
 */
import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { ValidationError } from './errors.js';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
  headers?: ZodTypeAny;
}

export interface Validated<T extends ValidationSchemas> {
  body: T['body'] extends ZodTypeAny ? z.infer<T['body']> : unknown;
  query: T['query'] extends ZodTypeAny ? z.infer<T['query']> : unknown;
  params: T['params'] extends ZodTypeAny ? z.infer<T['params']> : unknown;
}

function formatIssues(error: z.ZodError): Array<{ path: string; message: string; code: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const issues: Array<{ path: string; message: string; code: string }> = [];

    for (const [source, schema] of Object.entries(schemas) as Array<[keyof ValidationSchemas, ZodTypeAny]>) {
      if (!schema) continue;
      const result = schema.safeParse(req[source]);
      if (result.success) {
        // 用解析后的值替换原始值（含类型转换与默认值），后续代码拿到的一定是干净数据
        (req as unknown as Record<string, unknown>)[source] = result.data;
      } else {
        issues.push(...formatIssues(result.error).map((i) => ({ ...i, path: `${source}.${i.path}` })));
      }
    }

    if (issues.length > 0) {
      return next(new ValidationError('Request validation failed.', issues));
    }
    next();
  };
}
