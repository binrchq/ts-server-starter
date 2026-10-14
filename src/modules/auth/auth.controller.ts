/**
 * 认证控制器。只做 HTTP 编解码 + 调用 service，不写业务规则。
 *
 * 关于 Cookie：refresh token 不放在响应体里回传前端更安全（httpOnly +
 * SameSite=Lax），但那是产品决策。这里默认走响应体（便于 CLI/移动端），
 * 需要 Web 场景时在 login 里 res.cookie(...) 即可，注释给了写法。
 */
import type { Request, Response } from 'express';
import { created, ok } from '../../shared/http/respond.js';
import { UnauthorizedError } from '../../shared/errors.js';
import { requestLogger } from '../../shared/request-context.js';
import { requirePrincipal } from '../../app/middleware/authenticate.js';
import type { AuthService } from './auth.service.js';
import type { LoginBody, RegisterBody } from './auth.schema.js';

export interface AuthController {
  register(req: Request, res: Response): Promise<void>;
  login(req: Request, res: Response): Promise<void>;
  refresh(req: Request, res: Response): Promise<void>;
  me(req: Request, res: Response): Promise<void>;
  logout(req: Request, res: Response): Promise<void>;
}

export function createAuthController(service: AuthService): AuthController {
  return {
    async register(req, res) {
      const body = req.body as RegisterBody;
      const result = await service.register({
        email: body.email,
        password: body.password,
        ...(body.displayName ? { displayName: body.displayName } : {}),
      });
      requestLogger().info('user registered', { userId: result.user.id });
      created(res, result);
    },

    async login(req, res) {
      const body = req.body as LoginBody;
      const result = await service.login(body.email, body.password);
      // Web 场景建议：
      //   res.cookie('refresh_token', result.tokens.refreshToken, {
      //     httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1/auth/refresh', maxAge: refreshTtlMs,
      //   });
      requestLogger().info('login succeeded', { userId: result.user.id });
      ok(res, result);
    },

    async refresh(req, res) {
      const token = (req.body as { refreshToken?: string }).refreshToken;
      if (!token) throw new UnauthorizedError('Missing refresh token.');
      ok(res, await service.refresh(token));
    },

    async me(req, res) {
      const principal = requirePrincipal(req);
      ok(res, await service.me(principal.userId));
    },

    async logout(req, res) {
      service.logout(requirePrincipal(req).userId);
      // 无状态令牌没有服务端会话可销毁。要做真正的登出需要：
      //   1. refresh token 白名单/黑名单（Redis + jti）
      //   2. 或改用服务端 session
      // 这里明确返回 204 并说明，不假装"已登出"。
      res.status(204).end();
    },
  };
}
