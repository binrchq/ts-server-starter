/**
 * 验证码服务 —— 短信/邮箱验证码的签发与校验。
 *
 * 对应 go-starter 的 `core/biz/verification/verification.go`，但把存储收敛到
 * `StateAdapter`：memory / redis / etcd 都能用，生产接哪个由配置决定，
 * 不额外引入一套独立的 redis 客户端与 key 约定。
 *
 * 安全上刻意做的四件事（每一条都对应一类真实事故）：
 *  1. **只存哈希**：验证码进数据库以 sha256 存储，库被读走也无法直接登录
 *  2. **限次**：同一验证码最多校验 maxAttempts 次，超过立即作废（抗枚举）
 *  3. **限频**：cooldown（两次发送间隔）+ dailyLimit（每日上限）双闸门
 *  4. **一次性**：校验成功立即删除，杜绝重放
 *
 * 另外，返回给客户端的永远是打码后的 target，验证码本身绝不进入响应体。
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { VerificationConfig } from '../../config/schema.js';
import type { StateAdapter } from '../../infra/state/types.js';
import { AuditAction, type Auditor } from '../../security/audit.js';
import { RateLimitedError, ServiceUnavailableError, UpstreamError, ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { maskTarget, type VerificationCodeSender } from './verification.sender.js';
import { targetKind, type SendCodeBody, type VerifyCodeBody, type VerificationPurpose } from './verification.schema.js';

const DAY_MS = 86_400_000;

interface StoredCode {
  /** sha256(code) 的十六进制 */
  hash: string;
  attempts: number;
  /** 显式记录过期时间：即便驱动没兑现 TTL，服务层也能兜底判断 */
  expiresAt: number;
}

export interface IssuedCode {
  /** 打码后的 target，可安全回给客户端 */
  target: string;
  expiresInMs: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'mismatch'; remainingAttempts: number }
  | { ok: false; reason: 'too_many_attempts'; remainingAttempts: 0 };

export interface VerificationServiceOptions {
  state: StateAdapter;
  sender: VerificationCodeSender;
  auditor: Auditor;
  logger: Logger;
  config: VerificationConfig;
}

/** 邮箱大小写不敏感；手机号只去空格。归一化保证「同一个人」只有一个码 */
export function normalizeTarget(target: string): string {
  const value = target.trim();
  return value.includes('@') ? value.toLowerCase() : value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 定长十六进制的比较，用 timingSafeEqual 避免按位比较带来的时间侧信道 */
function hashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class VerificationService {
  constructor(private readonly options: VerificationServiceOptions) {}

  private get config(): VerificationConfig {
    return this.options.config;
  }

  private codeKey(target: string, purpose: VerificationPurpose): string {
    return `verification:code:${purpose}:${target}`;
  }
  private cooldownKey(target: string, purpose: VerificationPurpose): string {
    return `verification:cooldown:${purpose}:${target}`;
  }
  private dailyKey(target: string, purpose: VerificationPurpose): string {
    return `verification:daily:${purpose}:${target}`;
  }

  /** 签发并发送验证码。返回打码后的 target，绝不返回验证码本身。 */
  async issue(input: SendCodeBody): Promise<IssuedCode> {
    if (!this.config.enabled) throw new ServiceUnavailableError('verification service is disabled');
    const target = normalizeTarget(input.target);
    this.assertPurposeMatchesTarget(target, input.purpose);

    const ttlMs = this.config.ttlMs;
    const cooldownKey = this.cooldownKey(target, input.purpose);

    // 冷却：SET NX，先到先得。抢不到说明刚刚发过 —— 直接拒绝，防短信轰炸
    if (this.config.cooldownMs > 0) {
      const allowed = await this.options.state.setIfAbsent(cooldownKey, Date.now(), this.config.cooldownMs);
      if (!allowed) {
        throw new RateLimitedError('A verification code was just sent. Please wait before requesting another.');
      }
    }

    const daily = await this.options.state.increment(this.dailyKey(target, input.purpose), 1, DAY_MS);
    if (daily > this.config.dailyLimit) {
      throw new RateLimitedError('Daily verification limit reached for this target.');
    }

    const code = this.generateCode();
    await this.options.state.set(
      this.codeKey(target, input.purpose),
      { hash: sha256(code), attempts: 0, expiresAt: Date.now() + ttlMs } satisfies StoredCode,
      ttlMs,
    );

    try {
      await this.options.sender.send({ target, purpose: input.purpose, code, ttlMs });
    } catch (err) {
      // 发送失败要回滚，否则用户既没收到码，又被冷却/额度挡住
      await this.options.state.delete(this.codeKey(target, input.purpose));
      await this.options.state.delete(cooldownKey);
      await this.options.state.increment(this.dailyKey(target, input.purpose), -1, DAY_MS);
      this.options.auditor.record({
        action: AuditAction.VerificationSent,
        outcome: 'failure',
        resource: `verification:${input.purpose}`,
        detail: { target: maskTarget(target) },
      });
      throw new UpstreamError('Failed to send verification code.', err);
    }

    this.options.auditor.record({
      action: AuditAction.VerificationSent,
      outcome: 'success',
      resource: `verification:${input.purpose}`,
      detail: { target: maskTarget(target) },
    });
    return { target: maskTarget(target), expiresInMs: ttlMs };
  }

  /** 校验验证码。失败原因对客户端可见（不带 target 是否存在的信息）。 */
  async verify(input: VerifyCodeBody): Promise<VerifyResult> {
    if (!this.config.enabled) throw new ServiceUnavailableError('verification service is disabled');
    const target = normalizeTarget(input.target);
    this.assertPurposeMatchesTarget(target, input.purpose);
    const key = this.codeKey(target, input.purpose);
    const stored = await this.options.state.get<StoredCode>(key);

    if (!stored || stored.expiresAt <= Date.now()) {
      if (stored) await this.options.state.delete(key);
      this.recordFailure(target, input.purpose, 'expired');
      return { ok: false, reason: 'expired' };
    }

    if (!hashEquals(stored.hash, sha256(input.code))) {
      const attempts = stored.attempts + 1;
      if (attempts >= this.config.maxAttempts) {
        await this.options.state.delete(key);
        this.recordFailure(target, input.purpose, 'too_many_attempts');
        return { ok: false, reason: 'too_many_attempts', remainingAttempts: 0 };
      }
      // StateAdapter 没有读回剩余 TTL 的能力，这里用配置 TTL 重写。
      // 影响有界：maxAttempts 生效后码即作废，不存在被无限续命的问题。
      await this.options.state.set(key, { ...stored, attempts } satisfies StoredCode, this.config.ttlMs);
      this.recordFailure(target, input.purpose, 'mismatch');
      return { ok: false, reason: 'mismatch', remainingAttempts: this.config.maxAttempts - attempts };
    }

    // 成功即消费，防重放
    await this.options.state.delete(key);
    this.options.auditor.record({
      action: AuditAction.VerificationVerified,
      outcome: 'success',
      resource: `verification:${input.purpose}`,
      detail: { target: maskTarget(target) },
    });
    return { ok: true };
  }

  /** 供其它模块（如登录/改密流程）使用的断言版本：不通过直接抛 400 */
  async assertVerified(input: VerifyCodeBody): Promise<void> {
    const result = await this.verify(input);
    if (result.ok) return;
    if (result.reason === 'too_many_attempts') {
      throw new RateLimitedError('Too many incorrect attempts. Please request a new code.');
    }
    throw new ValidationError(
      result.reason === 'expired' ? 'The verification code has expired.' : 'The verification code is incorrect.',
      { reason: result.reason },
    );
  }

  /** 主动作废（例如用户取消流程、或管理员封禁） */
  async invalidate(target: string, purpose: VerificationPurpose): Promise<boolean> {
    return this.options.state.delete(this.codeKey(normalizeTarget(target), purpose));
  }

  private generateCode(): string {
    let code = '';
    // randomInt 是密码学安全的且无模偏差，effort 上优于 randomBytes % 10
    for (let i = 0; i < this.config.length; i += 1) code += String(randomInt(0, 10));
    return code;
  }

  private assertPurposeMatchesTarget(target: string, purpose: VerificationPurpose): void {
    const kind = targetKind(target);
    if (kind === null) throw new ValidationError('target must be an email address or a phone number');
    if (purpose === 'bind_email' && kind !== 'email') {
      throw new ValidationError('purpose "bind_email" requires an email target');
    }
    if (purpose === 'bind_phone' && kind !== 'phone') {
      throw new ValidationError('purpose "bind_phone" requires a phone target');
    }
  }

  private recordFailure(target: string, purpose: VerificationPurpose, reason: string): void {
    this.options.logger.debug('verification code rejected', { purpose, target: maskTarget(target), reason });
    this.options.auditor.record({
      action: AuditAction.VerificationFailed,
      outcome: 'denied',
      resource: `verification:${purpose}`,
      detail: { target: maskTarget(target), reason },
    });
  }
}
