/**
 * Prisma 驱动。
 *
 * 存在意义：大部分 TS 业务的 schema 与查询都写在 Prisma 里，
 * 硬塞进 query(sql) 抽象得不偿失。所以这里把 PrismaClient 作为
 * 「文档型」驱动暴露，业务层通过 `db.native` 拿到强类型 client。
 *
 * 两个已知坑（都在这里一次性处理）：
 *  1. Prisma 7 的驱动适配器是必需的，`new PrismaClient()` 会直接抛错；
 *  2. PrismaPg 会忽略连接串里的 search_path，schema 必须显式传入第二参数。
 */
import type { Database, DriverContext, Executor, QueryResult } from './types.js';

interface PrismaLike {
  $queryRawUnsafe(sql: string, ...params: unknown[]): Promise<unknown>;
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T>;
}

function resolveSchema(ctx: DriverContext): string {
  if (process.env.DB_SCHEMA) return process.env.DB_SCHEMA;
  const fromConfig = ctx.config.schema;
  if (fromConfig) return fromConfig;
  try {
    const parsed = new URL(ctx.dsn);
    return parsed.searchParams.get('schema') ?? 'public';
  } catch {
    return 'public';
  }
}

class PrismaDatabase implements Database {
  readonly driver = 'prisma' as const;
  readonly dialect = 'document' as const;

  constructor(private readonly client: PrismaLike) {}

  get native(): PrismaLike {
    return this.client;
  }

  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const rows = (await this.client.$queryRawUnsafe(sql, ...params)) as T[];
    return { rows, rowCount: rows.length };
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params)).rows[0];
  }

  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => {
      const executor: Executor = {
        query: async <R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
          const rows = (await tx.$queryRawUnsafe(sql, ...params)) as R[];
          return { rows, rowCount: rows.length } as QueryResult<R>;
        },
        queryOne: async <R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
          ((await tx.$queryRawUnsafe(sql, ...params)) as R[])[0],
      };
      return fn(executor);
    });
  }

  async ping(): Promise<void> {
    await this.client.$queryRawUnsafe('SELECT 1');
  }

  async close(): Promise<void> {
    await this.client.$disconnect();
  }
}

// 可选依赖的包名（写成常量是为了让动态 import 的说明符不是字面量，
// 详见下方注释说明）
const CLIENT_PACKAGE = '@prisma/client';
const ADAPTER_PACKAGE = '@prisma/adapter-pg';

export async function createPrismaDatabase(ctx: DriverContext): Promise<Database> {
  const schema = resolveSchema(ctx);

  let PrismaClientCtor: new (options: { adapter: unknown }) => PrismaLike;
  let PrismaPgCtor: new (options: { connectionString: string }, extra?: { schema?: string }) => unknown;

  try {
    // 用变量做 import 说明符是刻意的：Prisma 是**可选**依赖，
    // 模板本身不安装它。写成字面量会让 tsc 在未安装时报 TS2307。
    const clientModule = (await import(CLIENT_PACKAGE)) as unknown as {
      PrismaClient: new (options: { adapter: unknown }) => PrismaLike;
    };
    PrismaClientCtor = clientModule.PrismaClient;
  } catch {
    throw new Error('prisma driver requires "@prisma/client". Run: pnpm prisma generate');
  }

  try {
    const adapterModule = (await import(ADAPTER_PACKAGE)) as unknown as {
      PrismaPg: new (options: { connectionString: string }, extra?: { schema?: string }) => unknown;
    };
    PrismaPgCtor = adapterModule.PrismaPg;
  } catch {
    throw new Error('prisma driver requires "@prisma/adapter-pg". Run: pnpm add @prisma/adapter-pg');
  }

  // PrismaPg 不会读取连接串里的 search_path，必须显式传 schema
  const adapter = new PrismaPgCtor({ connectionString: ctx.dsn }, { schema });
  const client = new PrismaClientCtor({ adapter });
  await client.$connect();
  return new PrismaDatabase(client);
}
