/**
 * 验证码发送侧。
 *
 * 服务只依赖这个接口，具体用短信、邮件还是第三方（Twilio / SES / 阿里云）
 * 由部署方注入。默认实现写日志 —— 它的价值在于**本地开发零配置**，
 * 而不是假装真的发出去了。
 */
import type { Logger } from '../../shared/logger.js';
import type { VerificationPurpose } from './verification.schema.js';

export interface VerificationSendInput {
  target: string;
  purpose: VerificationPurpose;
  code: string;
  ttlMs: number;
}

export interface VerificationCodeSender {
  readonly name: string;
  send(input: VerificationSendInput): Promise<void>;
}

/** 把邮箱/手机号打码后再进日志，避免日志成为验证码/PII 的泄漏源 */
export function maskTarget(target: string): string {
  if (target.includes('@')) {
    const [local, domain] = target.split('@');
    const head = local?.slice(0, 1) ?? '';
    return `${head}${'*'.repeat(Math.max(1, (local?.length ?? 1) - 1))}@${domain ?? ''}`;
  }
  const tail = target.slice(-4);
  return `${'*'.repeat(Math.max(1, target.length - 4))}${tail}`;
}

/**
 * 默认 sender：结构化日志。
 *
 * `exposeCode` 为 true 时把验证码写进日志（仅 dev/test：
 * config 校验会拒绝 prod + expose_in_logs 的组合）。
 * 即使开启，也只打给明确订阅了该 component 的日志，不会出现在 HTTP 响应里。
 */
export function createLoggingSender(logger: Logger, exposeCode: boolean): VerificationCodeSender {
  const log = logger.component('verification');
  return {
    name: 'logging',
    async send(input) {
      const masked = maskTarget(input.target);
      if (exposeCode) {
        log.warn('verification code issued (code exposed by config)', {
          target: masked,
          purpose: input.purpose,
          code: input.code,
          ttlMs: input.ttlMs,
        });
      } else {
        log.info('verification code issued', {
          target: masked,
          purpose: input.purpose,
          ttlMs: input.ttlMs,
        });
      }
    },
  };
}

/**
 * 测试/内存 sender：把发出的消息留在数组里供断言。
 * 生产若误用，就会「发送成功但用户永远收不到」—— 因此名字与文档都点明用途。
 */
export function createMemorySender(): VerificationCodeSender & { readonly sent: VerificationSendInput[] } {
  const sent: VerificationSendInput[] = [];
  return {
    name: 'memory',
    sent,
    async send(input) {
      sent.push(input);
    },
  };
}
