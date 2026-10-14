/**
 * admin 路由 —— 运营/管理后台。
 *
 * 与 outer 的区别：即使拿到普通用户令牌也进不来（requireRoles(['admin'])），
 * 且所有敏感操作都会写审计日志（AuditAction.AdminAction）。
 */
import type { Router } from 'express';
import { createRouteGroup } from '../../route-group.js';
import { ok } from '../../../../shared/http/respond.js';
import { configInfo } from '../../../../config/schema.js';
import type { RouterDeps } from '../types.js';

export const ADMIN_LAYER = 'admin';
export const ADMIN_PREFIX = '/admin';

export function createAdminRouter(deps: RouterDeps): Router {
  const { router, group } = createRouteGroup({
    layer: ADMIN_LAYER,
    prefix: ADMIN_PREFIX,
    registry: deps.registry,
    guards: deps.guards,
    defaults: { access: 'admin' },
  });

  deps.modules.health.mount(group);
  deps.modules.user.mountAdmin(group);

  group.get(
    '/info',
    async (_req, res) => {
      // configInfo() 是脱敏摘要：绝不含密码/密钥（见 config/schema.ts）
      ok(res, {
        config: configInfo(deps.ctx.config, deps.configSource),
        services: deps.ctx.services.getNodeInfo(),
        routes: deps.registry.list().length,
        node: process.version,
      });
    },
    { description: '运行配置摘要（已脱敏）' },
  );

  // 审计检索。sink 只配了 logger 时会如实返回 persisted:false —— 空列表和
  // 「审计没开」是两件不同的事，接口必须能区分。
  deps.modules.audit.mountAdmin(group);

  return router;
}
