/**
 * 安全相关的加解密小工具。
 * 所有比较都走 timingSafeEqual，避免 token/签名校验被时序侧信道爆破。
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** 常量时间字符串比较；长度不同直接返回 false（长度本身不是机密） */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export function uuid(): string {
  return randomUUID();
}

/** 生成带前缀的 API Key，返回明文与可存储的哈希 */
export function generateApiKey(prefix = 'sk_live', secretBytes = 24) {
  const secret = randomBytes(secretBytes).toString('hex');
  const key = `${prefix}_${secret}`;
  return {
    key,
    hash: sha256(key),
    /** 展示用片段，例如 sk_live_3f9a2b */
    preview: key.slice(0, prefix.length + 7),
  };
}

/** 把机密字段打码，供日志/接口回显使用 */
export function maskSecret(value: string, visible = 4): string {
  if (!value) return '';
  if (value.length <= visible * 2) return '*'.repeat(value.length);
  return `${value.slice(0, visible)}${'*'.repeat(Math.min(16, value.length - visible * 2))}${value.slice(-visible)}`;
}
