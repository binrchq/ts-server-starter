import { z } from 'zod';

export const taskStatusSchema = z.enum(['pending', 'running', 'done', 'failed']);

export const createTaskBodySchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(120),
  description: z.string().trim().max(2000).optional(),
  /** 到期时间（ISO 8601），用于定时扫描逾期任务 */
  dueAt: z.coerce.date().optional(),
  priority: z.number().int().min(0).max(9).default(0),
});

export const updateTaskBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    status: taskStatusSchema.optional(),
    dueAt: z.coerce.date().nullable().optional(),
    priority: z.number().int().min(0).max(9).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field must be provided' });

export const listTasksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: taskStatusSchema.optional(),
  keyword: z.string().trim().max(64).optional(),
});

export const taskIdParamSchema = z.object({
  id: z.string().uuid('must be a valid uuid'),
});

export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;
export type UpdateTaskBody = z.infer<typeof updateTaskBodySchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
