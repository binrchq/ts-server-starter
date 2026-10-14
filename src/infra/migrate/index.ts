/**
 * 迁移入口。目录按方言区分：migrations/{postgres,mysql,sqlite}
 */
import path from 'node:path';
import type { Config } from '../../config/schema.js';
import type { Logger } from '../../shared/logger.js';
import type { Database } from '../database/types.js';
import { Migrator, type SqlDialect } from './migrator.js';

export * from './migrator.js';

export function dialectFor(driver: string): SqlDialect {
  if (driver === 'mysql') return 'mysql';
  if (driver === 'sqlite' || driver === 'sqlite3') return 'sqlite';
  return 'postgres';
}

export interface CreateMigratorOptions {
  database: Database;
  config: Config;
  logger: Logger;
  /** 项目根目录，默认 process.cwd() */
  rootDir?: string;
}

export function createMigrator(options: CreateMigratorOptions): Migrator {
  const dialect = dialectFor(options.config.database.driver);
  const root = options.rootDir ?? process.cwd();
  return new Migrator({
    database: options.database,
    dialect,
    directory: path.resolve(root, 'migrations', dialect),
    // schema 只在 Postgres 有意义；其它方言给了也会被忽略
    schema: options.config.database.schema,
    logger: options.logger,
  });
}
