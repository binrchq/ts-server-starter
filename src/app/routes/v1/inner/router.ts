/**
 * inner 路由 —— 服务间调用，只在集群内网暴露。
 *
 * 认证方式：共享密钥头（requireInternalToken，常量时间比较）。
 * 内容：健康、就绪、依赖状态、定时任务快照、服务状态。
 * 这类信息对外是攻击面（暴露内部拓扑），因此绝不挂到 outer 端口。
 */
import type { Router } from 'express';
import { createRouteGroup } from '../../route-group.js';
import { ok } from '../../../../shared/http/respond.js';
import type { RouterDeps } from '../types.js';

export const INNER_LAYER = 'inner';
export const INNER_PREFIX = '/internal';

export function createInnerRouter(deps: RouterDeps): Router {
  const { router, group } = createRouteGroup({
    layer: INNER_LAYER,
    prefix: INNER_PREFIX,
    registry: deps.registry,
    guards: deps.guards,
    // 内网端口默认全部要求内部令牌
    defaults: { access: 'internal' },
  });

  deps.modules.health.mount(group);

  group.get(
    '/status',
    async (_req, res) => {
      ok(res, {
        app: deps.ctx.config.app,
        environment: deps.ctx.config.environment,
        services: deps.ctx.services.getNodeInfo(),
        timers: deps.ctx.timerWheel.snapshot(),
        uptimeSeconds: Math.round(process.uptime()),
      });
    },
    { description: '服务与定时任务状态' },
  );

  group.get(
    '/routes',
    async (_req, res) => {
      ok(res, deps.registry.list());
    },
    { description: '路由矩阵（供线上自查）' },
  );

  return router;
}
