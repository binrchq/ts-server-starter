import { randomUUID } from 'node:crypto';
import type { RouteGroup } from '../../app/routes/route-group.js';
import type { Authenticator } from '../../app/middleware/authenticate.js';
import type { Logger } from '../../shared/logger.js';
import { AuthService, createTokenAuthenticator } from './auth.service.js';
import { createAuthController, type AuthController } from './auth.controller.js';
import { loginBodySchema, refreshBodySchema, registerBodySchema } from './auth.schema.js';
import { createTokenSigner } from './token.js';
import type { UserRepository } from './user.repository.js';
import type { Auditor } from '../../security/audit.js';

export * from './auth.controller.js';
export * from './auth.schema.js';
export * from './auth.service.js';
export * from './token.js';
export * from './user.repository.js';

export interface AuthModuleOptions {
  users: UserRepository;
  logger: Logger;
  auditor: Auditor;
  sessionSecret: string;
  issuer: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  devBypass?: { userId: string; roles: string[] } | null;
}

export interface AuthModule {
  service: AuthService;
  controller: AuthController;
  authenticator: Authenticator;
  /**
   * DEV_AUTH_BYPASS 便利：把 bypass 身份真正落库。
   *
   * 不这么做的话，绕过鉴权拿到的 userId 在数据库里并不存在，
   * 于是 /auth/me 之类的接口会以「账号已不存在」401 —— 一个只在开发期出现、
   * 却很容易被误判成"鉴权写错了"的坑。
   */
  ensureDevUser(): Promise<void>;
  mount(group: RouteGroup): void;
}

export function createAuthModule(options: AuthModuleOptions): AuthModule {
  const signer = createTokenSigner(options.sessionSecret, options.issuer);
  const service = new AuthService({
    users: options.users,
    signer,
    logger: options.logger,
    auditor: options.auditor,
    accessTtlSeconds: options.accessTtlSeconds ?? 3600,
    refreshTtlSeconds: options.refreshTtlSeconds ?? 30 * 86_400,
  });
  const controller = createAuthController(service);
  const authenticator = createTokenAuthenticator({
    signer,
    devBypass: options.devBypass ?? null,
  });

  return {
    service,
    controller,
    authenticator,

    async ensureDevUser() {
      const bypass = options.devBypass;
      if (!bypass) return;
      if (await options.users.findById(bypass.userId)) return;

      await options.users.create({
        id: bypass.userId,
        email: `${bypass.userId}@dev.local`,
        // 随机密码：这个账号无法用密码登录，只能走 bypass —— 免得开发用弱口令泄漏到别处
        password: randomUUID(),
        displayName: 'Development User',
        roles: bypass.roles,
      });
      options.logger.warn('dev auth bypass enabled; a development user was seeded', {
        userId: bypass.userId,
        roles: bypass.roles,
      });
    },

    mount(group) {
      // 公开子分组：/api/v1/public/auth/*
      const pub = group.group('/public');
      pub.post('/auth/register', controller.register, {
        schemas: { body: registerBodySchema },
        rateLimit: 'auth',
        description: '注册并直接签发令牌',
      });
      pub.post('/auth/login', controller.login, {
        schemas: { body: loginBodySchema },
        rateLimit: 'auth',
        description: '账号密码登录（限流抗撞库）',
      });
      pub.post('/auth/refresh', controller.refresh, {
        schemas: { body: refreshBodySchema },
        rateLimit: 'auth',
        description: '刷新 access token',
      });
      group.get('/auth/me', controller.me, { access: 'user', description: '当前登录用户' });
      group.post('/auth/logout', controller.logout, {
        access: 'user',
        description: '无状态令牌：客户端丢弃即可',
      });
    },
  };
}
