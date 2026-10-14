import { describe, expect, it } from 'vitest';
import { createTokenSigner } from '../src/modules/auth/token.js';

const SECRET = 'test-secret-at-least-32-characters-long!';
const signer = createTokenSigner(SECRET, 'test-issuer');

describe('JWT signer', () => {
  it('签发后校验通过，并带回 subject 与 roles', () => {
    const token = signer.sign('user-1', ['user']);
    const payload = signer.verify(token, { audience: 'access' });
    expect(payload.sub).toBe('user-1');
    expect(payload.roles).toEqual(['user']);
    expect(payload.iss).toBe('test-issuer');
  });

  it('篡改 payload 会被签名校验发现', () => {
    const token = signer.sign('user-1', ['user']);
    const [header, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin-1', roles: ['admin'] })).toString('base64url');
    expect(() => signer.verify(`${header}.${forged}.${signature}`, { audience: 'access' })).toThrow();
    void payload;
  });

  it('alg=none 的令牌被拒绝（算法固定，防降级攻击）', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'attacker', roles: ['admin'] })).toString('base64url');
    expect(() => signer.verify(`${header}.${payload}.`, { audience: 'access' })).toThrow();
  });

  it('别的密钥签出的令牌无效', () => {
    const other = createTokenSigner('a-completely-different-secret-32-bytes!!', 'test-issuer');
    const token = other.sign('user-1', ['user']);
    expect(() => signer.verify(token, { audience: 'access' })).toThrow();
  });

  it('过期令牌被拒绝（含 30s 时钟偏移容忍）', () => {
    const token = signer.sign('user-1', ['user'], { ttlSeconds: -120 });
    expect(() => signer.verify(token, { audience: 'access' })).toThrow(/expired/i);
  });

  it('notBefore 未到期的令牌被拒绝', () => {
    const future = new Date(Date.now() + 10 * 60_000);
    const token = signer.sign('user-1', ['user'], { ttlSeconds: 3600, notBefore: future });
    expect(() => signer.verify(token, { audience: 'access' })).toThrow(/not valid yet/i);
  });

  it('受众不匹配被拒绝：refresh 令牌不能当 access 用', () => {
    const token = signer.sign('user-1', [], { ttlSeconds: 60, audience: 'refresh' });
    expect(() => signer.verify(token, { audience: 'access' })).toThrow(/audience/i);
    // 用对了受众就能通过
    expect(signer.verify(token, { audience: 'refresh' }).aud).toBe('refresh');
  });

  it('默认受众是 access', () => {
    const token = signer.sign('user-1', ['user']);
    expect(signer.verify(token).aud).toBe('access');
  });

  it('格式错误的令牌被拒绝而不是抛 500', () => {
    expect(() => signer.verify('not-a-jwt', { audience: 'access' })).toThrow();
    expect(() => signer.verify('a.b.c', { audience: 'access' })).toThrow();
  });
});
