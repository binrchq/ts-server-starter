/**
 * 验证码模块的入参 schema。
 *
 * target 允许邮箱与手机号两种形态 —— 具体哪种由 purpose 决定
 * （bind_email 要邮箱、bind_phone 要手机号），这层只能做粗校验，
 * 精确的「形态与用途是否匹配」放在 service 里，错误信息才说得清。
 */
import { z } from 'zod';

export const verificationPurposes = ['login', 'register', 'reset_password', 'bind_email', 'bind_phone'] as const;
export const verificationPurposeSchema = z.enum(verificationPurposes);
export type VerificationPurpose = (typeof verificationPurposes)[number];

/** 刻意写得保守：只排除明显不是邮箱/手机号的输入，不做 RFC 级别校验收窄合法值 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9]{6,20}$/;

export type TargetKind = 'email' | 'phone';

export function targetKind(target: string): TargetKind | null {
  const value = target.trim();
  if (EMAIL_RE.test(value)) return 'email';
  if (PHONE_RE.test(value)) return 'phone';
  return null;
}

export const verificationTargetSchema = z
  .string()
  .trim()
  .min(3, 'target is too short')
  .max(254, 'target is too long')
  .refine((value) => targetKind(value) !== null, {
    message: 'target must be an email address or a phone number',
  });

export const sendCodeBodySchema = z.object({
  target: verificationTargetSchema,
  purpose: verificationPurposeSchema,
});

export const verifyCodeBodySchema = z.object({
  target: verificationTargetSchema,
  purpose: verificationPurposeSchema,
  // 位数由服务端配置决定，这里只约束字符集与合理长度
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{4,8}$/, 'code must be 4-8 digits'),
});

export type SendCodeBody = z.infer<typeof sendCodeBodySchema>;
export type VerifyCodeBody = z.infer<typeof verifyCodeBodySchema>;
