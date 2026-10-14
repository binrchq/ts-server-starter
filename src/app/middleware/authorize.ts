/**
 * 授权中间件：角色、scope、内部令牌。
 *
 * 内部令牌（inner 路由）用共享密钥 + 常量时间比较 ——
 * 普通 `===` 会在第一个不同字节处返回，理论上可被逐字节爆破。
 * 另外：密钥未配置时必须**拒绝**而不是放行（fail-closed）。
 */
import type { RequestHandler } from 'express';
import { timingSafeEqualString } from '../../shared/crypto.js';
import { ForbiddenError, ServiceUnavailableError, UnauthorizedError } from '../../shared/errors.js';
import type { AuditActionName, Auditor } from '../../security/audit.js';
import { AuditAction } from '../../security/audit.js';

export interface AuthorizeOptions {
  auditor?: Auditor;
}

/** 要求主体具备任一角色（roles 为空表示只要求已认证） */
export function requireRoles(roles: string[], options: AuthorizeOptions = {}): RequestHandler {
  return (req, _res, next) => {
    const principal = req.principal;
    if (!principal) return next(new UnauthorizedError());
    if (roles.length === 0) return next();

    if (!principal.roles.some((role) => roles.includes(role))) {
      const action: AuditActionName = AuditAction.AccessDenied;
      options.auditor?.record({
        action,
        outcome: 'denied',
        userId: principal.userId,
        resource: `${req.method} ${req.baseUrl}${req.path}`,
        detail: { requiredRoles: roles, actualRoles: principal.roles },
      });
      return next(new ForbiddenError(`Requires one of role(s): ${roles.join(', ')}.`));
    }
    next();
  };
}

/** 要求主体具备全部 scope（API Key 场景） */
export function requireScopes(scopes: string[], options: AuthorizeOptions = {}): RequestHandler {
  return (req, _res, next) => {
    const principal = req.principal;
    if (!principal) return next(new UnauthorizedError());

    const granted = new Set(principal.scopes ?? []);
    const missing = scopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      options.auditor?.record({
        action: AuditAction.AccessDenied,
        outcome: 'denied',
        userId: principal.userId,
        resource: `${req.method} ${req.baseUrl}${req.path}`,
        detail: { missingScopes: missing },
      });
      return next(new ForbiddenError(`Missing required scope(s): ${missing.join(', ')}.`));
    }
    next();
  };
}

export interface InternalTokenOptions {
  /** 共享密钥；为空则内网路由直接不可用（fail-closed） */
  secret: string;
  headerName?: string;
}

/** 服务间调用的共享密钥守卫 */
export function requireInternalToken(options: InternalTokenOptions): RequestHandler {
  const headerName = (options.headerName ?? 'x-internal-token').toLowerCase();

  return (req, _res, next) => {
    if (!options.secret) {
      return next(
        new ServiceUnavailableError('Internal API is disabled: no internal token configured.', {
          hint: 'set security.internal_token (or SECURITY__INTERNAL_TOKEN) to enable the inner router',
        }),
      );
    }
    const provided = req.header(headerName);
    if (!provided || !timingSafeEqualString(provided, options.secret)) {
      return next(new UnauthorizedError('Invalid internal token.'));
    }
    next();
  };
}
