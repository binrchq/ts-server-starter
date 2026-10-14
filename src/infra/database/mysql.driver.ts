/**
 * MySQL 驱动。mysql2 是可选依赖 —— 用不到就不装，
 * 因此这里走动态 import，只有真正选择该驱动时才要求存在。
 * 同理适用于 sqlite / mongodb / prisma（详见各自文件）。
 */
import type { Database, DriverContext, Executor, QueryResult } from './types.js';

interface MysqlPool {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  getConnection(): Promise<MysqlConnection>;
  end(): Promise<void>;
}

interface MysqlConnection extends Pick<MysqlPool, 'query'> {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

class MysqlExecutor implements Executor {
  constructor(private readonly conn: Pick<MysqlPool, 'query'>) {}

  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const [rows] = await this.conn.query(sql, params as unknown[]);
    const list = Array.isArray(rows) ? (rows as T[]) : [];
    return { rows: list, rowCount: list.length };
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params)).rows[0];
  }
}

class MysqlDatabase implements Database {
  readonly driver = 'mysql' as const;
  readonly dialect = 'sql' as const;

  constructor(private readonly pool: MysqlPool) {}

  get native(): MysqlPool {
    return this.pool;
  }

  query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    return new MysqlExecutor(this.pool).query<T>(sql, params);
  }

  queryOne<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return new MysqlExecutor(this.pool).queryOne<T>(sql, params);
  }

  async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(new MysqlExecutor(conn));
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function createMysqlDatabase(ctx: DriverContext): Promise<Database> {
  const moduleName = 'mysql2/promise';
  let createPool: (options: Record<string, unknown>) => unknown;
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as unknown as {
      createPool: (options: Record<string, unknown>) => unknown;
    };
    createPool = mod.createPool;
  } catch {
    throw new Error('mysql driver requires the optional dependency "mysql2". Install it with: pnpm add mysql2');
  }

  const pool = createPool({
    host: ctx.config.host,
    port: ctx.config.port,
    user: ctx.config.username,
    password: ctx.config.password,
    database: ctx.config.name,
    connectionLimit: ctx.config.maxOpenConns || 10,
    waitForConnections: true,
    namedPlaceholders: false,
  }) as MysqlPool;

  return new MysqlDatabase(pool);
}
