/**
 * `migrate` 子命令：up / down / status / create。
 *
 * 注意：迁移命令会**独立建立数据库连接**并在结束时关闭，
 * 不复用 serve 的容器 —— 否则一条 CLI 命令会带着整套 HTTP 依赖启动。
 */
import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { createLogger } from '../../shared/logger.js';
import { createDatabase } from '../../infra/database/index.js';
import { createMigrator } from '../../infra/migrate/index.js';

interface CommonOptions {
  config?: string;
  steps?: number;
  to?: string;
}

async function withMigrator<T>(
  options: CommonOptions,
  fn: (migrator: ReturnType<typeof createMigrator>, logger: ReturnType<typeof createLogger>) => Promise<T>,
): Promise<T> {
  const config = loadConfig(options.config ? { configPath: options.config } : {});
  const logger = createLogger({
    level: config.logging.level,
    format: 'text',
    output: 'stdout',
  });
  const database = await createDatabase(config.database, config.app.name);
  try {
    const migrator = createMigrator({ database, config, logger });
    return await fn(migrator, logger);
  } finally {
    await database.close();
  }
}

export function createMigrateCommand(): Command {
  const command = new Command('migrate').description('数据库迁移（纯 SQL 文件）');

  command
    .command('up')
    .description('应用待执行的迁移')
    .option('-c, --config <path>', 'config.yaml 路径')
    .option('--steps <number>', '最多应用几个', (value) => Number.parseInt(value, 10))
    .option('--to <version>', '应用到指定版本（含）')
    .action(async (options: CommonOptions) => {
      await withMigrator(options, async (migrator, logger) => {
        const applied = await migrator.up({
          ...(options.steps !== undefined ? { steps: options.steps } : {}),
          ...(options.to ? { to: options.to } : {}),
        });
        logger.info('migrate up finished', { applied: applied.length });
      });
    });

  command
    .command('down')
    .description('回滚迁移（需要对应的 .down.sql）')
    .option('-c, --config <path>', 'config.yaml 路径')
    .option('--steps <number>', '回滚几个', (value) => Number.parseInt(value, 10))
    .option('--to <version>', '回滚到指定版本（不含）')
    .action(async (options: CommonOptions) => {
      await withMigrator(options, async (migrator, logger) => {
        const reverted = await migrator.down({
          ...(options.steps !== undefined ? { steps: options.steps } : {}),
          ...(options.to ? { to: options.to } : {}),
        });
        logger.info('migrate down finished', { reverted: reverted.length });
      });
    });

  command
    .command('status')
    .description('显示已应用 / 待执行 / 内容漂移的迁移')
    .option('-c, --config <path>', 'config.yaml 路径')
    .action(async (options: CommonOptions) => {
      await withMigrator(options, async (migrator, logger) => {
        const state = await migrator.state();
        logger.info('migration status', {
          applied: state.applied.length,
          pending: state.pending.map((m) => m.version),
          drifted: state.drifted.map((d) => d.version),
        });
        for (const migration of state.applied) {
          process.stdout.write(`  applied  ${migration.version}  ${migration.name}\n`);
        }
        for (const migration of state.pending) {
          process.stdout.write(`  pending  ${migration.version}  ${migration.name}\n`);
        }
      });
    });

  command
    .command('create <name>')
    .description('生成一对 up/down 迁移文件')
    .option('-c, --config <path>', 'config.yaml 路径')
    .action(async (name: string, options: CommonOptions) => {
      const config = loadConfig(options.config ? { configPath: options.config } : {});
      const logger = createLogger({ level: 'info', format: 'text', output: 'stdout' });
      const database = await createDatabase(config.database, config.app.name);
      try {
        const migrator = createMigrator({ database, config, logger });
        const created = migrator.create(name);
        process.stdout.write(`created ${created.up}\ncreated ${created.down}\n`);
      } finally {
        await database.close();
      }
    });

  return command;
}
