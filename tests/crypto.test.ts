import { describe, expect, it } from 'vitest';
import { generateApiKey, maskSecret, randomToken, sha256, timingSafeEqualString } from '../src/shared/crypto.js';
import { hashPassword, verifyPassword } from '../src/shared/password.js';

describe('crypto helpers', () => {
  it('sha256 稳定且长度为 64', () => {
    expect(sha256('abc')).toHaveLength(64);
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
  });

  it('常量时间比较：等价返回 true，长度不同直接 false', () => {
    expect(timingSafeEqualString('token-abc', 'token-abc')).toBe(true);
    expect(timingSafeEqualString('token-abc', 'token-abd')).toBe(false);
    // 长度不同时不做逐字节比较（长度本身不是机密），直接判否
    expect(timingSafeEqualString('short', 'much-longer-value')).toBe(false);
  });

  it('generateApiKey 返回明文 + 哈希 + 前缀，且明文不可从哈希还原', () => {
    const key = generateApiKey('sk_live');
    expect(key.key.startsWith('sk_live_')).toBe(true);
    expect(key.hash).toBe(sha256(key.key));
    expect(key.key).not.toBe(key.hash);
  });

  it('randomToken 每次不同且长度符合预期（base64url 每字节 ≈ 1.33 字符）', () => {
    const a = randomToken(16);
    const b = randomToken(16);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(22);
  });

  it('maskSecret 保留首尾可见字符，中间打码，短串整体隐藏', () => {
    expect(maskSecret('sk_live_abcdefghijklmn')).toMatch(/^sk_l\*+klmn$/);
    expect(maskSecret('abc')).toBe('***');
    expect(maskSecret('')).toBe('');
  });

  it('密码用 scrypt 加盐哈希：同一密码两次结果不同，但都能验证通过', async () => {
    const h1 = await hashPassword('correct horse battery staple');
    const h2 = await hashPassword('correct horse battery staple');
    expect(h1).not.toBe(h2);
    expect(await verifyPassword('correct horse battery staple', h1)).toBe(true);
    expect(await verifyPassword('wrong password', h1)).toBe(false);
  });

  it('损坏的哈希串不会抛异常，只会验证失败', async () => {
    expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
  });
});
