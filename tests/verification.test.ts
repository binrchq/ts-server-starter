/**
 * 验证码服务测试。
 *
 * 这些用例刻意围绕「会被攻击者利用的边界」而不是 happy path：
 *   - 库里存的是哈希，不是明文
 *   - 校验成功即作废（重放）
 *   - 失败次数累计后作废（枚举）
 *   - 冷却 + 每日上限（短信轰炸）
 *   - 发送失败要回滚（否则用户既收不到又被限流）
 */
import { describe, expect, it } from 'vitest';
import { defaultConfig, type VerificationConfig } from '../src/config/schema.js';
import { AuditAction, Auditor, type AuditEvent } from '../src/security/audit.js';
import { RateLimitedError, ServiceUnavailableError, UpstreamError, ValidationError } from '../src/shared/errors.js';
import { createLogger } from '../src/shared/logger.js';
import { VerificationService, normalizeTarget } from '../src/modules/verification/verification.service.js';
import { createMemorySender, maskTarget } from '../src/modules/verification/verification.sender.js';
import { StubState } from './helpers/stub-infra.js';

const silentLogger = createLogger({ level: 'silent', format: 'text', output: 'stdout' });

function setup(overrides: Partial<VerificationConfig> = {}) {
  const state = new StubState();
  const sender = createMemorySender();
  const events: AuditEvent[] = [];
  const auditor = new Auditor([{ name: 'test', write: (event) => void events.push(event) }]);
  const config = { ...defaultConfig().verification, ...overrides };
  const service = new VerificationService({ state, sender, auditor, logger: silentLogger, config });
  return { state, sender, events, service, config };
}

const LOGIN = { target: 'User@Example.com', purpose: 'login' as const };

describe('target 归一化与打码', () => {
  it('邮箱大小写归一，手机号保留', () => {
    expect(normalizeTarget('  A@B.COM ')).toBe('a@b.com');
    expect(normalizeTarget('+8613800138000')).toBe('+8613800138000');
  });

  it('打码不泄漏完整 target', () => {
    expect(maskTarget('alice@example.com')).toBe('a****@example.com');
    expect(maskTarget('13800138000')).toBe('*******8000');
  });
});

describe('签发', () => {
  it('只存哈希，且响应里没有验证码', async () => {
    const { service, state, sender } = setup();
    const issued = await service.issue(LOGIN);

    expect(issued.target).toBe('u***@example.com');
    expect(issued).not.toHaveProperty('code');
    expect(sender.sent).toHaveLength(1);

    const stored = await state.get<{ hash: string; attempts: number }>('verification:code:login:user@example.com');
    expect(stored).toBeDefined();
    expect(stored?.hash).toHaveLength(64); // sha256 hex
    expect(stored?.hash).not.toBe(sender.sent[0]?.code);
    expect(JSON.stringify(issued)).not.toContain(sender.sent[0]?.code ?? '###');
  });

  it('冷却期内再次发送被拒（防短信轰炸）', async () => {
    const { service } = setup({ cooldownMs: 60_000 });
    await service.issue(LOGIN);
    await expect(service.issue(LOGIN)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('超过每日上限被拒', async () => {
    const { service } = setup({ cooldownMs: 0, dailyLimit: 2 });
    await service.issue(LOGIN);
    await service.issue(LOGIN);
    await expect(service.issue(LOGIN)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('发送失败会回滚：冷却与额度都被释放', async () => {
    const { state, config } = setup({ cooldownMs: 60_000 });
    const service = new VerificationService({
      state,
      sender: { name: 'boom', send: async () => Promise.reject(new Error('sms gateway down')) },
      auditor: new Auditor([]),
      logger: silentLogger,
      config,
    });

    await expect(service.issue(LOGIN)).rejects.toBeInstanceOf(UpstreamError);
    expect(await state.get('verification:code:login:user@example.com')).toBeUndefined();
    expect(await state.get('verification:cooldown:login:user@example.com')).toBeUndefined();
    // 额度回滚到 0，否则一次网关抖动就吃掉用户当天的次数
    expect(await state.get('verification:daily:login:user@example.com')).toBe(0);
  });

  it('purpose 与 target 形态不匹配时报 400', async () => {
    const { service } = setup();
    await expect(service.issue({ target: '13800138000', purpose: 'bind_email' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.issue({ target: 'a@b.com', purpose: 'bind_phone' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('服务被关闭时拒绝签发', async () => {
    const { service } = setup({ enabled: false });
    await expect(service.issue(LOGIN)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});

describe('校验', () => {
  it('正确验证码通过，且立即作废（防重放）', async () => {
    const { service, sender, events } = setup();
    await service.issue(LOGIN);
    const code = sender.sent[0]?.code ?? '';

    expect(await service.verify({ ...LOGIN, code })).toEqual({ ok: true });
    // 第二次相同验证码必然失败
    expect(await service.verify({ ...LOGIN, code })).toEqual({ ok: false, reason: 'expired' });
    expect(events.some((e) => e.action === AuditAction.VerificationVerified)).toBe(true);
  });

  it('错误验证码累计次数，达到上限即作废', async () => {
    const { service, sender } = setup({ maxAttempts: 3 });
    await service.issue(LOGIN);
    const correct = sender.sent[0]?.code ?? '';

    expect(await service.verify({ ...LOGIN, code: '000000' })).toEqual({
      ok: false,
      reason: 'mismatch',
      remainingAttempts: 2,
    });
    expect(await service.verify({ ...LOGIN, code: '000001' })).toEqual({
      ok: false,
      reason: 'mismatch',
      remainingAttempts: 1,
    });
    expect(await service.verify({ ...LOGIN, code: '000002' })).toEqual({
      ok: false,
      reason: 'too_many_attempts',
      remainingAttempts: 0,
    });
    // 作废后，连正确的码也不再可用
    expect(await service.verify({ ...LOGIN, code: correct })).toEqual({ ok: false, reason: 'expired' });
  });

  it('过期验证码返回 expired', async () => {
    const { service, sender } = setup({ ttlMs: 1 });
    await service.issue(LOGIN);
    const code = sender.sent[0]?.code ?? '';
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await service.verify({ ...LOGIN, code })).toEqual({ ok: false, reason: 'expired' });
  });

  it('assertVerified 失败时抛 ValidationError，超限抛 RateLimitedError', async () => {
    const { service } = setup({ maxAttempts: 2 });
    await service.issue(LOGIN);
    // 第一次错：还剩一次机会 → 普通校验错误
    await expect(service.assertVerified({ ...LOGIN, code: '000000' })).rejects.toBeInstanceOf(ValidationError);
    // 第二次错：达到上限 → 限流类错误（语义上“别再试了”）
    await expect(service.assertVerified({ ...LOGIN, code: '000001' })).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('invalidate 可主动作废', async () => {
    const { service, sender, state } = setup();
    await service.issue(LOGIN);
    expect(await service.invalidate(LOGIN.target, 'login')).toBe(true);
    expect(await state.get('verification:code:login:user@example.com')).toBeUndefined();
    void sender;
  });
});

describe('审计', () => {
  it('签发/成功/失败都会留痕，且 detail 里只有打码 target', async () => {
    const { service, sender, events } = setup({ maxAttempts: 2 });
    await service.issue(LOGIN);
    await service.verify({ ...LOGIN, code: '000000' });
    await service.verify({ ...LOGIN, code: sender.sent[0]?.code ?? '' });

    const actions = events.map((e) => e.action);
    expect(actions).toContain(AuditAction.VerificationSent);
    expect(actions).toContain(AuditAction.VerificationFailed);
    expect(actions).toContain(AuditAction.VerificationVerified);
    expect(JSON.stringify(events)).not.toContain('user@example.com');
  });
});
