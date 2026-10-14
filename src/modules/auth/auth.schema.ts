/**
 * 认证模块的入参 schema。
 *
 * 口令策略刻意明确（长度上限 128 防止用超长口令做 DoS ——
 * scrypt 是 CPU 密集的，`{password: "x".repeat(1e7)}` 足以打满一个核）。
 */
import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'email is too short')
  .max(254, 'email is too long')
  .email('must be a valid email address');

export const passwordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(128, 'password must be at most 128 characters');

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(64).optional(),
});

export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(10).max(4096),
});

export const listUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  keyword: z.string().trim().max(64).optional(),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
