/**
 * 审计日志仓储。
 *
 * 与其它模块的内存仓储不同，审计**必须**落库：内存实现在进程重启后
 * 什么都不剩，而审计的价值恰恰在于事后追查。
 *
 * 这一层只依赖 Database 抽象，所以 postgres / mysql / sqlite 都能用；
 * 方言差异（占位符、JSON 列）由 infra/database/sql.ts 承担。
 */
import type { Database } from '../../infra/database/types.js';
import { bind, dialectOf, valuesClause, type SqlDialect } from '../../infra/database/sql.js';
import type { AuditEvent, AuditOutcome } from '../../security/audit.js';

export interface AuditLogRecord {
  id: string;
  action: string;
  outcome: AuditOutcome;
  userId?: string;
  resource: string;
  ip: string;
  userAgent: string;
  requestId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface AuditTailQuery {
  limit: number;
  action?: string;
  userId?: string;
  outcome?: AuditOutcome;
}

export interface AuditRepository {
  /** 批量写入；调用方（buffered sink）保证单批不会过大 */
  writeMany(events: readonly AuditEvent[]): Promise<void>;
  tail(query: AuditTailQuery): Promise<AuditLogRecord[]>;
  total(): Promise<number>;
}

const COLUMNS = ['action', 'outcome', 'user_id', 'resource', 'ip', 'user_agent', 'request_id', 'detail'] as const;

/**
 * 把列值转成字符串。
 *
 * 直接 `String(value)` 有个隐蔽的坑：对象会变成 "[object Object]"，信息全丢。
 * 类型上虽然列声明为 TEXT，但驱动返回什么只有在真库上才能确定，
 * 所以这里显式处理每种标量，其余退化到 JSON —— 宁可多几个字符也不要丢内容。
 */
function asString(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? fallback;
}

/** DB 里可能存的是 JSON 字符串（sqlite/mysql）也可能是已解析对象（pg jsonb） */
function normalizeDetail(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { _unparsed: value };
    }
  }
  if (typeof value === 'object') return value as Record<string, unknown>;
  return { _unparsed: asString(value) };
}

function normalizeDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return asString(value);
}

function toRecord(row: Record<string, unknown>): AuditLogRecord {
  return {
    id: asString(row.id),
    action: asString(row.action),
    outcome: asString(row.outcome) as AuditOutcome,
    userId: row.user_id === null || row.user_id === undefined ? undefined : asString(row.user_id),
    resource: asString(row.resource),
    ip: asString(row.ip),
    userAgent: asString(row.user_agent),
    requestId: asString(row.request_id),
    detail: normalizeDetail(row.detail),
    createdAt: normalizeDate(row.created_at),
  };
}

export class SqlAuditRepository implements AuditRepository {
  private readonly dialect: SqlDialect;

  constructor(
    private readonly database: Database,
    readonly table = 'audit_logs',
  ) {
    // 明确早失败：文档型驱动没有 SQL 方言，静默降级会让人以为审计已经落库
    if (database.dialect !== 'sql') {
      throw new Error(`audit_logs requires a SQL database, got driver "${database.driver}"`);
    }
    this.dialect = dialectOf(database.driver);
  }

  async writeMany(events: readonly AuditEvent[]): Promise<void> {
    if (events.length === 0) return;

    const placeholders = valuesClause(events.length, COLUMNS.length, this.dialect);
    const sql = `INSERT INTO ${this.table} (${COLUMNS.join(', ')}) VALUES ${placeholders}`;
    const params: unknown[] = [];
    for (const event of events) {
      params.push(
        String(event.action).slice(0, 64),
        event.outcome,
        event.userId ?? null,
        event.resource ?? '',
        event.ip ?? '',
        event.userAgent ?? '',
        event.requestId ?? '',
        JSON.stringify(event.detail ?? {}),
      );
    }
    await this.database.query(sql, params);
  }

  async tail(query: AuditTailQuery): Promise<AuditLogRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.action) {
      where.push(`action = ${this.dialect === 'postgres' ? `$${params.length + 1}` : '?'}`);
      params.push(query.action);
    }
    if (query.userId) {
      where.push(`user_id = ${this.dialect === 'postgres' ? `$${params.length + 1}` : '?'}`);
      params.push(query.userId);
    }
    if (query.outcome) {
      where.push(`outcome = ${this.dialect === 'postgres' ? `$${params.length + 1}` : '?'}`);
      params.push(query.outcome);
    }
    const limitPlaceholder = this.dialect === 'postgres' ? `$${params.length + 1}` : '?';
    params.push(query.limit);

    const sql =
      `SELECT id, action, outcome, user_id, resource, ip, user_agent, request_id, detail, created_at` +
      ` FROM ${this.table}` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`;

    const result = await this.database.query<Record<string, unknown>>(bind(sql, this.dialect), params);
    return result.rows.map(toRecord);
  }

  async total(): Promise<number> {
    const row = await this.database.queryOne<{ total: number | string }>(`SELECT COUNT(*) AS total FROM ${this.table}`);
    return row ? Number(row.total) : 0;
  }
}
