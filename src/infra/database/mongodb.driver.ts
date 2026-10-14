/**
 * MongoDB 驱动（可选依赖 mongodb）。
 * 文档型没有统一的 SQL 面，因此 query() 直接拒绝，业务通过 native 句柄操作。
 */
import { NotImplementedError } from '../../shared/errors.js';
import type { Database, DriverContext, Executor, QueryResult } from './types.js';

interface MongoHandle {
  db(name?: string): unknown;
  close(): Promise<void>;
  command(doc: Record<string, unknown>): Promise<unknown>;
}

class MongodbDatabase implements Database {
  readonly driver = 'mongodb' as const;
  readonly dialect = 'document' as const;

  constructor(
    private readonly client: MongoHandle,
    private readonly dbName: string,
  ) {}

  get native(): MongoHandle {
    return this.client;
  }

  get database(): unknown {
    return this.client.db(this.dbName);
  }

  async query<T = Record<string, unknown>>(): Promise<QueryResult<T>> {
    throw new NotImplementedError('mongodb driver does not expose SQL; use the native handle (db.collection(...))');
  }

  async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
    throw new NotImplementedError('mongodb driver does not expose SQL; use the native handle (db.collection(...))');
  }

  async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    // 需要副本集才支持多文档事务；这里要求用 client.withSession 自行处理
    void fn;
    throw new NotImplementedError('mongodb transactions require a replica set; use client.withSession() directly');
  }

  async ping(): Promise<void> {
    await this.client.command({ ping: 1 });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export async function createMongodbDatabase(ctx: DriverContext): Promise<Database> {
  const moduleName = 'mongodb';
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as {
      MongoClient: new (url: string, options?: Record<string, unknown>) => MongoHandle;
    };
    const client = new mod.MongoClient(ctx.dsn, {
      maxPoolSize: ctx.config.maxOpenConns || 10,
      minPoolSize: ctx.config.maxIdleConns || 0,
      serverSelectionTimeoutMS: 5000,
    });
    return new MongodbDatabase(client, ctx.config.name);
  } catch {
    throw new Error('mongodb driver requires the optional dependency "mongodb". Install it with: pnpm add mongodb');
  }
}
