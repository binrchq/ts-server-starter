/**
 * 认证中间件。
 *
 * 这里只做「传输层」的事：从请求里取出凭据 → 交给 Authenticator 校验 →
 * 把结果写进 req.user 与请求上下文。**具体令牌格式不在这里定义**，
 * 由 src/modules/auth 提供实现（JWT / session / API Key / 外部 SDK）。
 *
 * 好处：换认证方案不需要改任何路由与控制器。
 */
import type { Request, RequestHandler } from 'express';
import { UnauthorizedError } from '../../shared/errors.js';
import { setCurrentUserId } from '../../shared/request-context.js';
import type { AuditActionName, Auditor, AuditOutcome } from '../../security/audit.js';
import { AuditAction } from '../../security/audit.js';

export interface AuthPrincipal {
  userId: string;
  roles: string[];
  scopes?: string[];
  /** 凭据来源，写入审计日志时很有用 */
  source: 'bearer' | 'api-key' | 'session' | 'internal' | 'dev-bypass';
  expiresInSeconds?: number;
}

export interface Authenticator {
  readonly name: string;
  /** 返回 null 表示无凭据或凭据无效；不要在这里抛业务错误 */
  authenticate(req: Request): Promise<AuthPrincipal | null>;
}

export interface AuthenticateOptions {
  authenticator: Authenticator;
  auditor: Auditor;
  /** 失败时是否记录审计事件（登录类接口用 true，公开接口可关掉减少噪音） */
  auditFailures?: boolean;
}

/** 取已认证主体；未认证则抛 401 */
export function requirePrincipal(req: Request): AuthPrincipal {
  if (!req.principal) throw new UnauthorizedError();
  return req.principal;
}

/** 可选认证：有凭据就解析，没有也放行 */
export function optionalAuthenticate(options: Pick<AuthenticateOptions, 'authenticator'>): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const principal = await options.authenticator.authenticate(req);
        if (principal) attach(req, principal);
      } catch {
        // 可选认证失败不阻断请求
      }
      next();
    })();
  };
}

/** 强制认证 */
export function authenticate(options: AuthenticateOptions): RequestHandler {
  const auditFailures = options.auditFailures ?? true;

  return (req, _res, next) => {
    void (async () => {
      let principal: AuthPrincipal | null = null;
      try {
        principal = await options.authenticator.authenticate(req);
      } catch (err) {
        record(options.auditor, auditFailures, 'failure', req, String((err as Error).message));
        return next(new UnauthorizedError('Invalid or expired credentials.'));
      }

      if (!principal) {
        record(options.auditor, auditFailures, 'failure', req, 'missing or invalid credentials');
        return next(new UnauthorizedError());
      }

      attach(req, principal);
      record(options.auditor, auditFailures, 'success', req, undefined, principal);
      next();
    })();
  };
}

function attach(req: Request, principal: AuthPrincipal): void {
  req.user = { userId: principal.userId };
  req.principal = principal;
  setCurrentUserId(principal.userId);
}

function record(
  auditor: Auditor,
  enabled: boolean,
  outcome: AuditOutcome,
  req: Request,
  reason?: string,
  principal?: AuthPrincipal,
): void {
  if (!enabled) return;
  const action: AuditActionName = outcome === 'success' ? AuditAction.AuthLogin : AuditAction.AuthFailed;
  auditor.record({
    action,
    outcome,
    userId: principal?.userId,
    resource: `${req.method} ${req.baseUrl}${req.path}`,
    detail: { reason, source: principal?.source, ip: req.ip },
  });
}
