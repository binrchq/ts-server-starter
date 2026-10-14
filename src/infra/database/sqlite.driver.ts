/**
 * SQLite 驱动（可选依赖 node:sqlite / better-sqlite3）。
 * 主要用于本地开发与单机部署。
 */
import type { Database, DriverContext, Executor, QueryResult } from './types.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface SqliteHandle {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

class SqliteExecutor implements Executor {
  constructor(private readonly handle: SqliteHandle) {}

  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const statement = this.handle.prepare(sql);
    const trimmed = sql.trimStart().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA') || trimmed.startsWith('WITH')) {
      const rows = statement.all(...params) as T[];
      return { rows, rowCount: rows.length };
    }
    statement.run(...params);
    return { rows: [], rowCount: 0 };
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params)).rows[0];
  }
}

class SqliteDatabase implements Database {
  readonly driver = 'sqlite' as const;
  readonly dialect = 'sql' as const;

  constructor(private readonly handle: SqliteHandle) {}

  get native(): SqliteHandle {
    return this.handle;
  }

  query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    return new SqliteExecutor(this.handle).query<T>(sql, params);
  }

  queryOne<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return new SqliteExecutor(this.handle).queryOne<T>(sql, params);
  }

  async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    this.handle.exec('BEGIN');
    try {
      const result = await fn(new SqliteExecutor(this.handle));
      this.handle.exec('COMMIT');
      return result;
    } catch (err) {
      this.handle.exec('ROLLBACK');
      throw err;
    }
  }

  async ping(): Promise<void> {
    this.handle.prepare('SELECT 1').all();
  }

  async close(): Promise<void> {
    this.handle.close();
  }
}

export async function createSqliteDatabase(ctx: DriverContext): Promise<Database> {
  const moduleName = 'better-sqlite3';
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as {
      default: (path: string) => SqliteHandle;
    };
    return new SqliteDatabase(mod.default(ctx.config.name || ':memory:'));
  } catch {
    throw new Error(
      'sqlite driver requires the optional dependency "better-sqlite3". Install it with: pnpm add better-sqlite3',
    );
  }
}
