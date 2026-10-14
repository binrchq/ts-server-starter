/**
 * 数据库驱动工厂。按配置选择实现；可选依赖按需加载。
 */
import type { DatabaseConfig } from '../../config/schema.js';
import { databaseDsn } from '../../config/schema.js';
import type { Database, DatabaseDriver, DriverContext } from './types.js';

export * from './types.js';
export * from './sharding.js';
export {
  TablePreparer,
  TablePreparerService,
  detectPeriodUnit,
  type PreparationOutcome,
  type PreparationResult,
  type TablePreparerOptions,
} from './table-preparer.js';

const FACTORIES: Record<DatabaseDriver, (ctx: DriverContext) => Promise<Database>> = {
  postgres: async (ctx) => (await import('./postgres.driver.js')).createPostgresDatabase(ctx),
  postgresql: async (ctx) => (await import('./postgres.driver.js')).createPostgresDatabase(ctx),
  mysql: async (ctx) => (await import('./mysql.driver.js')).createMysqlDatabase(ctx),
  sqlite: async (ctx) => (await import('./sqlite.driver.js')).createSqliteDatabase(ctx),
  sqlite3: async (ctx) => (await import('./sqlite.driver.js')).createSqliteDatabase(ctx),
  mongodb: async (ctx) => (await import('./mongodb.driver.js')).createMongodbDatabase(ctx),
  prisma: async (ctx) => (await import('./prisma.driver.js')).createPrismaDatabase(ctx),
};

export async function createDatabase(config: DatabaseConfig, applicationName: string): Promise<Database> {
  const factory = FACTORIES[config.driver];
  if (!factory) throw new Error(`unsupported database driver: ${config.driver}`);
  return factory({ config, dsn: databaseDsn(config), applicationName });
}
