/**
 * PostgreSQL 驱动（node-postgres）。
 *
 * 注意：pg 的 Pool 是惰性建连的，所以 start() 阶段必须 ping 一次，
 * 否则「服务已启动」其实是假的 —— 第一个请求才会暴露连不上。
 */
import { Pool, type PoolClient, type QueryResult as PgQueryResult } from 'pg';
import type { Database, DriverContext, Executor, QueryResult } from './types.js';
import { searchPathOptions } from './pg-schema.js';

type Row = Record<string, unknown>;

// pg 的泛型要求 T extends QueryResultRow，而我们的 Database 接口对行的约束更松，
// 所以在边界处做一次受控转换，对外仍保持 QueryResult<T> 的泛型形状。
function toQueryResult<T>(result: PgQueryResult<Row>): QueryResult<T> {
  return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
}

class PgExecutor implements Executor {
  constructor(private readonly client: Pick<PoolClient, 'query'>) {}

  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    // pg 的 query 重载返回 QueryResult<any>，这里显式标注目标类型而不是二次断言
    const result: PgQueryResult<Row> = await this.client.query(sql, params as unknown[]);
    return toQueryResult<T>(result);
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const result = await this.query<T>(sql, params);
    return result.rows[0];
  }
}

class PostgresDatabase implements Database {
  readonly driver = 'postgres' as const;
  readonly dialect = 'sql' as const;
  readonly pool: Pool;

  constructor(ctx: DriverContext) {
    this.pool = new Pool({
      connectionString: ctx.dsn,
      max: ctx.config.maxOpenConns || 10,
      idleTimeoutMillis: ctx.config.connMaxIdleTimeMs || 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: ctx.applicationName,
      ...searchPathOptions(ctx.config.schema),
    });
    // 池内错误（如后端重启）必须监听，否则会变成 uncaughtException
    this.pool.on('error', () => {
      /* 由 ping() / 请求期错误处理 */
    });
  }

  get native(): Pool {
    return this.pool;
  }

  query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    return new PgExecutor(this.pool).query<T>(sql, params);
  }

  queryOne<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return new PgExecutor(this.pool).queryOne<T>(sql, params);
  }

  async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx = new PgExecutor(client);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 连接已断时 ROLLBACK 也会失败，忽略：连接会被池丢弃
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function createPostgresDatabase(ctx: DriverContext): Promise<Database> {
  return new PostgresDatabase(ctx);
}
