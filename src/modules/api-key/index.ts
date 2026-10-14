import type { RouteGroup } from '../../app/routes/route-group.js';
import type { Authenticator } from '../../app/middleware/authenticate.js';
import type { Auditor } from '../../security/audit.js';
import type { Logger } from '../../shared/logger.js';
import { createApiKeyController, type ApiKeyController } from './api-key.controller.js';
import { InMemoryApiKeyRepository, type ApiKeyRepository } from './api-key.repository.js';
import { ApiKeyService } from './api-key.service.js';
import { API_KEY_SCOPES, isValidScope } from './scopes.js';
import { z } from 'zod';

export * from './api-key.controller.js';
export * from './api-key.repository.js';
export * from './api-key.service.js';
export * from './scopes.js';

const createApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  // 用枚举校验而不是 z.array(z.string())：拼错 scope 会在入参阶段就被拒绝
  scopes: z
    .array(z.string())
    .min(1)
    .max(API_KEY_SCOPES.length)
    .refine((scopes) => scopes.every(isValidScope), {
      message: `scopes must be a subset of: ${API_KEY_SCOPES.join(', ')}`,
    })
    .transform((scopes) => scopes),
});

const apiKeyIdParamSchema = z.object({ id: z.string().uuid('must be a valid uuid') });

export interface ApiKeyModuleOptions {
  repository?: ApiKeyRepository;
  auditor: Auditor;
  logger: Logger;
}

export interface ApiKeyModule {
  service: ApiKeyService;
  controller: ApiKeyController;
  repository: ApiKeyRepository;
  /** 供 openapi 层使用的 API Key 认证策略 */
  authenticator: Authenticator;
  mount(group: RouteGroup): void;
}

export function createApiKeyModule(options: ApiKeyModuleOptions): ApiKeyModule {
  const repository = options.repository ?? new InMemoryApiKeyRepository();
  const service = new ApiKeyService({ repository, auditor: options.auditor, logger: options.logger });
  const controller = createApiKeyController(service);

  const authenticator: Authenticator = {
    name: 'api-key',
    async authenticate(req) {
      // 只在请求头里接受密钥：查询串会进日志与 Referer
      const raw = req.header('x-api-key');
      if (!raw) return null;
      const record = await service.verify(raw);
      if (!record) return null;
      return {
        userId: record.userId,
        // 主体是密钥所属用户，但角色单独标记，便于和人类会话区分开
        roles: ['user', 'api'],
        scopes: record.scopes,
        source: 'api-key',
      };
    },
  };

  return {
    service,
    controller,
    repository,
    authenticator,
    mount(group) {
      group.get('/keys', controller.list, { access: 'user', description: '我的 API Key 列表' });
      group.post('/keys', controller.create, {
        access: 'user',
        schemas: { body: createApiKeyBodySchema },
        description: '创建 API Key（明文仅返回一次）',
      });
      group.delete('/keys/:id', controller.revoke, {
        access: 'user',
        schemas: { params: apiKeyIdParamSchema },
        description: '撤销 API Key',
      });
    },
  };
}
