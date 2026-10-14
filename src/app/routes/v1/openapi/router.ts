/**
 * openapi 路由 —— 面向第三方合作方。
 *
 * 两条硬性约束（与 outer 的本质区别）：
 *  1. 认证只用 API Key（X-Api-Key），**不接受**浏览器 Cookie
 *  2. CORS 允许任意来源但不带 credentials（见 security/cors.ts），
 *     否则等于把用户的浏览器会话借给外部站点
 *
 * 每个端点用 requireScopes 声明所需权限域，scope 不匹配返回 403 并写审计。
 */
import type { Router } from 'express';
import { createRouteGroup } from '../../route-group.js';
import { ok } from '../../../../shared/http/respond.js';
import type { RouterDeps } from '../types.js';
import type { AppContext } from '../../../context.js';
import type { RouteGuards } from '../../route-group.js';
import { requirePrincipal } from '../../../middleware/authenticate.js';

export const OPENAPI_LAYER = 'openapi';
export const OPENAPI_PREFIX = '/openapi/v1';

export interface OpenApiRouterDeps {
  ctx: AppContext;
  /** openapi 层专用（API Key 认证），与 outer 的 guards 不同 */
  guards: RouteGuards;
  registry: RouterDeps['registry'];
}

export function createOpenApiRouter(deps: OpenApiRouterDeps): Router {
  const { router, group } = createRouteGroup({
    layer: OPENAPI_LAYER,
    prefix: OPENAPI_PREFIX,
    registry: deps.registry,
    guards: deps.guards,
    defaults: { access: 'user' },
  });

  group.get(
    '/ping',
    async (_req, res) => {
      ok(res, { pong: true, auth: 'api-key' });
    },
    { description: '连通性探测（仍需 API Key）' },
  );

  group.get(
    '/whoami',
    async (req, res) => {
      const principal = requirePrincipal(req);
      ok(res, {
        userId: principal.userId,
        scopes: principal.scopes ?? [],
        source: principal.source,
      });
    },
    { description: '当前 API Key 的身份与权限域', middleware: [deps.guards.requireScopes(['user:read'])] },
  );

  return router;
}
