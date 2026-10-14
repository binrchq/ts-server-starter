import type { Request, Response } from 'express';
import { ok, paginated } from '../../shared/http/respond.js';
import { requirePrincipal } from '../../app/middleware/authenticate.js';
import type { UserService } from './user.service.js';
import type { ListUsersQuery, UpdateProfileBody } from './user.schema.js';

export interface UserController {
  profile(req: Request, res: Response): Promise<void>;
  update(req: Request, res: Response): Promise<void>;
  getById(req: Request, res: Response): Promise<void>;
  list(req: Request, res: Response): Promise<void>;
}

export function createUserController(service: UserService): UserController {
  return {
    async profile(req, res) {
      ok(res, await service.getProfile(requirePrincipal(req).userId));
    },

    async update(req, res) {
      ok(res, await service.updateProfile(requirePrincipal(req).userId, req.body as UpdateProfileBody));
    },

    async getById(req, res) {
      ok(res, await service.getById(String(req.params.id)));
    },

    async list(req, res) {
      const query = req.query as unknown as ListUsersQuery;
      paginated(res, await service.listUsers(query));
    },
  };
}
