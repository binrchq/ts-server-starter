import type { Request, Response } from 'express';
import { created, noContent, ok } from '../../shared/http/respond.js';
import { requirePrincipal } from '../../app/middleware/authenticate.js';
import type { ApiKeyService } from './api-key.service.js';
import type { ApiKeyScopes } from './scopes.js';

export interface ApiKeyController {
  list(req: Request, res: Response): Promise<void>;
  create(req: Request, res: Response): Promise<void>;
  revoke(req: Request, res: Response): Promise<void>;
}

export function createApiKeyController(service: ApiKeyService): ApiKeyController {
  return {
    async list(req, res) {
      ok(res, await service.list(requirePrincipal(req).userId));
    },

    async create(req, res) {
      const body = req.body as { name: string; scopes: ApiKeyScopes[] };
      created(res, await service.create(requirePrincipal(req).userId, body));
    },

    async revoke(req, res) {
      await service.revoke(requirePrincipal(req).userId, String(req.params.id));
      noContent(res);
    },
  };
}
