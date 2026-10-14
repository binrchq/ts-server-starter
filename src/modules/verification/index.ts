import type { RouteGroup } from '../../app/routes/route-group.js';
import type { VerificationConfig } from '../../config/schema.js';
import type { StateAdapter } from '../../infra/state/types.js';
import type { Auditor } from '../../security/audit.js';
import type { Logger } from '../../shared/logger.js';
import { createVerificationController, type VerificationController } from './verification.controller.js';
import { VerificationService } from './verification.service.js';
import { createLoggingSender, type VerificationCodeSender } from './verification.sender.js';
import { sendCodeBodySchema, verifyCodeBodySchema } from './verification.schema.js';

export * from './verification.controller.js';
export * from './verification.schema.js';
export * from './verification.sender.js';
export * from './verification.service.js';

export interface VerificationModuleOptions {
  config: VerificationConfig;
  state: StateAdapter;
  auditor: Auditor;
  logger: Logger;
  /** 默认写日志；生产应注入真实的短信/邮件 sender */
  sender?: VerificationCodeSender;
}

export interface VerificationModule {
  service: VerificationService;
  controller: VerificationController;
  mount(group: RouteGroup): void;
}

export function createVerificationModule(options: VerificationModuleOptions): VerificationModule {
  const sender = options.sender ?? createLoggingSender(options.logger, options.config.exposeInLogs);
  const service = new VerificationService({
    state: options.state,
    sender,
    auditor: options.auditor,
    logger: options.logger,
    config: options.config,
  });
  const controller = createVerificationController(service);

  return {
    service,
    controller,
    mount(group) {
      if (!options.config.enabled) return;
      if (options.state.driver === 'memory') {
        // 多实例部署下内存态验证码会「本机发、另一台校验」而失败，
        // 这类问题排查成本极高，所以在启动期就明确告警。
        options.logger.warn('verification is enabled with in-memory state; codes will not work across instances', {
          driver: options.state.driver,
        });
      }
      const pub = group.group('/public/verification');
      pub.post('/codes', controller.send, {
        // 昂贵且可被滥用（短信费用）：按严格档限流
        rateLimit: 'strict:verification',
        schemas: { body: sendCodeBodySchema },
        description: '发送验证码（短信/邮箱）',
      });
      pub.post('/verify', controller.verify, {
        rateLimit: 'strict:verification',
        schemas: { body: verifyCodeBodySchema },
        description: '校验验证码',
      });
    },
  };
}
