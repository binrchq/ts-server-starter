/**
 * Express 4 不会捕获 async handler 抛出的 Promise rejection，
 * 漏掉就会静默挂起请求。这里统一包一层并交给 next()。
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(fn: AsyncRouteHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
