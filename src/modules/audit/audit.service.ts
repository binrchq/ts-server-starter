import type { Logger } from '../../shared/logger.js';
import type { BufferedAuditSink, BufferedAuditSinkStats } from '../../security/audit-sink.js';
import type { AuditLogRecord, AuditRepository, AuditTailQuery } from './audit.repository.js';

export interface AuditStatus {
  /** 是否真的落库了。false 表示只进了日志 sink */
  persisted: boolean;
  sinks: string[];
  stats?: BufferedAuditSinkStats;
  total?: number;
}

export class AuditService {
  constructor(
    private readonly options: {
      repository?: AuditRepository;
      sink?: BufferedAuditSink;
      logger: Logger;
    },
  ) {}

  get persisted(): boolean {
    return this.options.repository !== undefined;
  }

  async status(): Promise<AuditStatus> {
    const { repository, sink } = this.options;
    return {
      persisted: repository !== undefined,
      sinks: sink ? ['logger', sink.name] : ['logger'],
      stats: sink?.stats(),
      total: repository ? await repository.total() : undefined,
    };
  }

  /**
   * 查询最近事件。
   *
   * 未落库时返回 `null` 而不是空数组 —— 「没有审计数据」和「审计没开」
   * 是完全不同的两件事，接口层面必须能区分。
   */
  async tail(query: AuditTailQuery): Promise<AuditLogRecord[] | null> {
    if (!this.options.repository) return null;
    return this.options.repository.tail(query);
  }

  /** 强制冲刷缓冲，供测试与优雅退出使用 */
  async flush(): Promise<void> {
    await this.options.sink?.flush();
  }
}
