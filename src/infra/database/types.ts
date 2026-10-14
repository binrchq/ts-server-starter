/**
 * 数据库驱动抽象。
 *
 * 为什么要抽象：Go 版 `database/sql` 天然提供同一套接口，
 * 换驱动只改 DSN。Node 生态没有等价层，所以这里自己定义
 * 一个最小公共面（query / transaction / ping / close），
 * 每个驱动负责把方言差异吃掉。
 *
 * 约定：所有 query 都必须参数化占位（$1/?），禁止字符串拼接 SQL ——
 * 这是防注入的唯一可靠手段。
 */
import type { DatabaseConfig } from '../../config/schema.js';

export type DatabaseDriver = 'postgres' | 'postgresql' | 'mysql' | 'sqlite' | 'sqlite3' | 'mongodb' | 'prisma';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface Executor {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** 单行查询，无结果返回 undefined */
  queryOne<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
}

export interface Database extends Executor {
  readonly driver: DatabaseDriver;
  /** 'sql' 支持 query()；'document'（mongodb/prisma）请用 native 句柄 */
  readonly dialect: 'sql' | 'document';
  /** 在事务中执行；回调抛错则自动回滚 */
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
  /** 驱动原生句柄：pg.Pool / PrismaClient / MongoClient —— 业务层需要方言能力时使用 */
  readonly native: unknown;
}

export interface DriverContext {
  config: DatabaseConfig;
  /** 已解析的连接串（含 schema 等参数） */
  dsn: string;
  /**
   * 写进 `application_name` 的服务名（Postgres 里能从 pg_stat_activity 看出
   * 哪条连接属于谁）。多服务共用一个库时，没有它就是一团无法区分的连接。
   */
  applicationName: string;
}

export type DriverFactory = (ctx: DriverContext) => Promise<Database>;
