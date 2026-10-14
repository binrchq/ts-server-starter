/**
 * 把请求级信息（requestId / ip / 路由层）塞进 AsyncLocalStorage。
 * 必须在 requestId 之后、任何业务中间件之前挂载。
 */
import type { RequestHandler } from 'express';
import { runWithRequestContext } from '../../shared/request-context.js';
import type { Logger } from '../../shared/logger.js';

export function requestContext(logger: Logger, layer: string): RequestHandler {
  const base = logger.component(`http-${layer}`);
  return (req, _res, next) => {
    runWithRequestContext(
      {
        requestId: req.requestId ?? 'unknown',
        ip: req.ip,
        userAgent: req.header('user-agent'),
        layer,
        logger: base.child({ requestId: req.requestId }),
      },
      next,
    );
  };
}
