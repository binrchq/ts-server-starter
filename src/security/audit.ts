/**
 * 安全审计。
 *
 * 与业务日志的区别：审计事件是「谁、在什么时候、对什么、做了什么、成功与否」，
 * 属于合规要求（等保/SOC2 都查这个），因此：
 *   - 结构固定，字段名不随业务变化
 *   - 失败与拒绝同样必须记录（攻击特征主要来自失败样本）
 *   - 可挂多个 sink（logger / 数据库 / 外部 SIEM），且 sink 异常不能影响主流程
 */
import type { Logger } from '../shared/logger.js';
import { getRequestContext } from '../shared/request-context.js';

export type AuditOutcome = 'success' | 'failure' | 'denied';

/** 预置动作名，避免各处手写字符串拼错；业务可自行扩展 */
export const AuditAction = {
  AuthLogin: 'auth.login',
  AuthRegistered: 'auth.registered',
  AuthLogout: 'auth.logout',
  AuthRefresh: 'auth.refresh',
  AuthFailed: 'auth.failed',
  AccessDenied: 'access.denied',
  RateLimited: 'rate.limited',
  ApiKeyCreated: 'api_key.created',
  ApiKeyRevoked: 'api_key.revoked',
  VerificationSent: 'verification.sent',
  VerificationVerified: 'verification.verified',
  VerificationFailed: 'verification.failed',
  SecretAccessed: 'secret.accessed',
  AdminAction: 'admin.action',
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction] | (string & {});

export interface AuditEvent {
  action: AuditActionName;
  outcome: AuditOutcome;
  userId?: string;
  /** 被操作对象，例如 "asset:vip-icon-42" */
  resource?: string;
  /** 结构化细节（务必先脱敏，见 redact.ts） */
  detail?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  /** 事件时间，默认取当前时间 */
  at?: string;
}

export interface AuditSink {
  readonly name: string;
  write(event: AuditEvent): void | Promise<void>;
}

/** 默认 sink：结构化日志。审计事件用固定 action 前缀，便于日志系统按 action 检索 */
export function createLoggerSink(logger: Logger): AuditSink {
  const log = logger.component('audit');
  return {
    name: 'logger',
    write(event) {
      const fields = {
        audit: true,
        action: event.action,
        outcome: event.outcome,
        userId: event.userId,
        resource: event.resource,
        ip: event.ip,
        requestId: event.requestId,
        ...event.detail,
      };
      if (event.outcome === 'success') log.info('audit', fields);
      else log.warn('audit', fields);
    },
  };
}

export class Auditor {
  private readonly sinks: AuditSink[];
  private readonly enabled: boolean;

  constructor(sinks: AuditSink[], enabled = true) {
    this.sinks = sinks;
    this.enabled = enabled;
  }

  addSink(sink: AuditSink): void {
    this.sinks.push(sink);
  }

  /**
   * 已挂载的 sink 名称。
   *
   * 启动日志要如实反映「审计到底落到哪」：写死 ['logger'] 会让人以为
   * 数据库 sink 没生效，于是去查一个根本不存在的问题。
   */
  get sinkNames(): string[] {
    return this.sinks.map((sink) => sink.name);
  }

  /**
   * 记录一条审计事件。上下文里的 userId / requestId / ip 会自动带上，
   * 调用方只需要关心 action / outcome / resource。
   */
  record(event: AuditEvent): void {
    if (!this.enabled) return;

    const ctx = getRequestContext();
    const enriched: AuditEvent = {
      at: new Date().toISOString(),
      userId: event.userId ?? ctx?.userId,
      requestId: event.requestId ?? ctx?.requestId,
      ip: event.ip ?? ctx?.ip,
      userAgent: event.userAgent ?? ctx?.userAgent,
      ...event,
    };

    for (const sink of this.sinks) {
      try {
        const result = sink.write(enriched);
        if (result instanceof Promise) result.catch(() => {});
      } catch {
        // sink 失败不能影响请求主流程
      }
    }
  }
}

/** 便捷函数：auditor.record 的语法糖 */
export function audit(
  auditor: Auditor,
  action: AuditActionName,
  outcome: AuditOutcome,
  extra: Partial<AuditEvent> = {},
): void {
  auditor.record({ action, outcome, ...extra });
}
