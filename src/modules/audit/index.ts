/**
 * 审计模块。
 *
 * 它把「安全子系统产生的审计事件」与「运营需要查询的审计数据」连起来：
 *   security.Auditor ──sink──▶ buffered sink ──▶ SqlAuditRepository ──▶ audit_logs
 *                                                                          │
 *                                        admin: GET /audit/tail ◀──────────┘
 *
 * 注意依赖方向：security 不认识 modules，modules 认识 security。
 * sink 通过结构化的 `AuditEventWriter` 接口拿仓储，所以两边都不需要 import 对方。
 */
import { z } from 'zod';
import type { Request, Response } from 'express';
import { ok } from '../../shared/http/respond.js';
import type { RouteGroup } from '../../app/routes/route-group.js';
import type { Logger } from '../../shared/logger.js';
import type { BufferedAuditSink } from '../../security/audit-sink.js';
import type { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';

export * from './audit.repository.js';
export * from './audit.service.js';

export const auditTailQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().trim().max(64).optional(),
  userId: z.string().trim().max(64).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
});

export type AuditTailRequestQuery = z.infer<typeof auditTailQuerySchema>;

export interface AuditModuleOptions {
  repository?: AuditRepository;
  sink?: BufferedAuditSink;
  logger: Logger;
}

export interface AuditModule {
  service: AuditService;
  /** 挂在 admin 层 */
  mountAdmin(group: RouteGroup): void;
}

export function createAuditModule(options: AuditModuleOptions): AuditModule {
  const service = new AuditService({ repository: options.repository, sink: options.sink, logger: options.logger });

  const tail = async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as AuditTailRequestQuery;
    const [records, status] = await Promise.all([service.tail(query), service.status()]);
    if (records === null) {
      // 如实说明「没开落库」，而不是返回空列表让人误以为没有安全事件
      ok(res, { persisted: false, sinks: status.sinks, hint: 'audit sink is logger-only' });
      return;
    }
    ok(res, { persisted: true, items: records, stats: status.stats, total: status.total });
  };

  return {
    service,
    mountAdmin(group) {
      group.get('/audit/tail', tail, {
        schemas: { query: auditTailQuerySchema },
        description: '审计日志检索（按时间倒序，可按 action/user/outcome 过滤）',
      });
    },
  };
}
