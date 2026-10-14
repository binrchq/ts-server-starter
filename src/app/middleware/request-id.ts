/**
 * 请求 ID。
 *
 * 安全细节：不能无条件信任客户端传来的 X-Request-Id ——
 * 它可以被塞入换行/控制字符做日志注入，也可以被用来污染关联检索。
 * 这里只接受「短且形状合法」的值，其余一律重新生成。
 */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}
