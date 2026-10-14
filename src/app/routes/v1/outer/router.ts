/**
 * outer 路由 —— 面向浏览器/客户端，暴露在公网端口。
 *
 *   /api/v1/public/*   匿名可访问（注册、登录、健康探测）
 *   /api/v1/*          需要用户令牌
 *
 * 这是唯一允许携带 Cookie 的端口（见 security/cors.ts 的 credentials 策略）。
 */
import type { Router } from 'express';
import { createRouteGroup } from '../../route-group.js';
import { ok } from '../../../../shared/http/respond.js';
import type { RouterDeps } from '../types.js';

export const OUTER_LAYER = 'outer';
export const OUTER_PREFIX = '/api/v1';

export function createOuterRouter(deps: RouterDeps): Router {
  const { router, group } = createRouteGroup({
    layer: OUTER_LAYER,
    prefix: OUTER_PREFIX,
    registry: deps.registry,
    guards: deps.guards,
  });

  // 连通性探测：不查依赖，只证明「这个端口活着、路由挂上了」
  group.get(
    '/public/ping',
    async (_req, res) => {
      ok(res, { pong: true, service: deps.ctx.config.app.name, version: deps.ctx.config.app.version });
    },
    { description: '连通性探测' },
  );

  // 模块挂载（顺序无关）
  deps.modules.health.mount(group);
  deps.modules.auth.mount(group);
  deps.modules.user.mount(group);
  deps.modules.task.mount(group);
  deps.modules.apiKey.mount(group);
  deps.modules.verification.mount(group);

  return router;
}
