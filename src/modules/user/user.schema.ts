import { z } from 'zod';
import { emailSchema } from '../auth/auth.schema.js';

export const updateProfileBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(64).optional(),
    email: emailSchema.optional(),
  })
  .refine((value) => value.displayName !== undefined || value.email !== undefined, {
    message: 'at least one field must be provided',
  });

export const userIdParamSchema = z.object({
  id: z.string().uuid('must be a valid uuid'),
});

export const listUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  keyword: z.string().trim().max(64).optional(),
});

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
