import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../../shared/http/respond.js';
import { requirePrincipal } from '../../app/middleware/authenticate.js';
import type { TaskService } from './task.service.js';
import type { CreateTaskBody, ListTasksQuery, UpdateTaskBody } from './task.schema.js';

export interface TaskController {
  create(req: Request, res: Response): Promise<void>;
  list(req: Request, res: Response): Promise<void>;
  get(req: Request, res: Response): Promise<void>;
  update(req: Request, res: Response): Promise<void>;
  remove(req: Request, res: Response): Promise<void>;
  stats(req: Request, res: Response): Promise<void>;
}

export function createTaskController(service: TaskService): TaskController {
  const owner = (req: Request): string => requirePrincipal(req).userId;

  return {
    async create(req, res) {
      created(res, await service.create(owner(req), req.body as CreateTaskBody));
    },
    async list(req, res) {
      paginated(res, await service.list(owner(req), req.query as unknown as ListTasksQuery));
    },
    async get(req, res) {
      ok(res, await service.get(owner(req), String(req.params.id)));
    },
    async update(req, res) {
      ok(res, await service.update(owner(req), String(req.params.id), req.body as UpdateTaskBody));
    },
    async remove(req, res) {
      await service.remove(owner(req), String(req.params.id));
      noContent(res);
    },
    async stats(req, res) {
      ok(res, await service.stats(owner(req)));
    },
  };
}
