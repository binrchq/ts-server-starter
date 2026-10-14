/**
 * TablePreparer —— 提前创建下期分表。
 *
 * 对应 go-starter 的 `core/preparer/database/table_preparer.go`。
 * 解决的问题一样：等到月初第一条写入才建表，会遇到锁竞争 / 建表失败丢数据；
 * 所以在距离期末还有一段时间时，就把下一期的表建好。
 *
 * 与 Go 版的两处差异：
 *  1. 不依赖 GORM 的 AutoMigrate，建表语句按方言生成（postgres / mysql / sqlite）；
 *  2. 时钟可注入，因此「月末前 3 天开始准备」这类时间逻辑可以被确定性地测出来，
 *     而不是靠 mock 时间或真的等到月底。
 */

import { AbstractService } from '../../core/service.js';
import type { ServiceContext } from '../../core/context.js';
import type { Logger } from '../../shared/logger.js';
import {
  type ShardDefinition,
  type ShardRegistry,
  type SqlDialect,
  formatShardSuffix,
  shardedTableName,
} from './sharding.js';
import type { Database } from './types.js';

type PeriodUnit = 'hour' | 'day' | 'month';

export interface TablePreparerOptions {
  database: Database;
  registry: ShardRegistry;
  logger: Logger;
  /** 后台巡检间隔 */
  checkIntervalMs: number;
  /** 距期末小于该值时开始准备下期表 */
  prepareAdvanceMs: number;
  /** 后缀格式，用于推断分表周期（含 DD 按天，含 HH 按小时，否则按月） */
  format: string;
  /** 建表前是否先查存在性（关闭则只依赖 CREATE TABLE IF NOT EXISTS） */
  checkExists: boolean;
  /** 可注入时钟，测试用 */
  now?: () => Date;
}

export interface PreparationOutcome {
  /** 本期后缀，例如 202604 */
  period: string;
  /** 本期对应要准备的日期（ISO） */
  target: string;
  created: string[];
  existing: string[];
  failed: Array<{ table: string; error: string }>;
}

export type PreparationResult = { skipped: true; reason: string } | ({ skipped: false } & PreparationOutcome);

/** 从格式推断分表周期。格式里出现的最细粒度就是周期。 */
export function detectPeriodUnit(format: string): PeriodUnit {
  if (format.includes('HH')) return 'hour';
  if (format.includes('DD')) return 'day';
  return 'month';
}

function startOfPeriod(date: Date, unit: PeriodUnit): Date {
  const start = new Date(date);
  start.setMinutes(0, 0, 0);
  if (unit === 'hour') return start;
  start.setHours(0);
  if (unit === 'day') return start;
  start.setDate(1);
  return start;
}

function addPeriod(date: Date, unit: PeriodUnit): Date {
  const next = new Date(date);
  if (unit === 'hour') next.setHours(next.getHours() + 1);
  else if (unit === 'day') next.setDate(next.getDate() + 1);
  else next.setMonth(next.getMonth() + 1);
  return next;
}

function defaultCreateSql(dialect: SqlDialect, shardedTable: string, baseTable: string): string {
  switch (dialect) {
    case 'postgres':
      // INCLUDING ALL 连索引/约束/默认值一起复制，否则分表和主表结构会逐渐漂移
      return `CREATE TABLE IF NOT EXISTS "${shardedTable}" (LIKE "${baseTable}" INCLUDING ALL)`;
    case 'mysql':
      return `CREATE TABLE IF NOT EXISTS \`${shardedTable}\` LIKE \`${baseTable}\``;
    case 'sqlite':
    default:
      // sqlite 不支持 CREATE TABLE LIKE；AS SELECT 能复制列名与近似类型，
      // 但主键/索引/约束不会跟着来。生产请用 definition.createSql 显式给出。
      return `CREATE TABLE IF NOT EXISTS "${shardedTable}" AS SELECT * FROM "${baseTable}" WHERE 1 = 0`;
  }
}

export class TablePreparer {
  private readonly database: Database;
  private readonly registry: ShardRegistry;
  private readonly logger: Logger;
  private readonly checkIntervalMs: number;
  private readonly prepareAdvanceMs: number;
  private readonly format: string;
  private readonly checkExists: boolean;
  private readonly now: () => Date;

  constructor(options: TablePreparerOptions) {
    this.database = options.database;
    this.registry = options.registry;
    this.logger = options.logger.component('table-preparer');
    this.checkIntervalMs = options.checkIntervalMs;
    this.prepareAdvanceMs = options.prepareAdvanceMs;
    this.format = options.format;
    this.checkExists = options.checkExists;
    this.now = options.now ?? (() => new Date());
  }

  private get dialect(): SqlDialect {
    if (this.database.driver.startsWith('mysql')) return 'mysql';
    if (this.database.driver.startsWith('sqlite')) return 'sqlite';
    return 'postgres';
  }

  /**
   * 下一期是否已进入「该准备了」的窗口。
   * 例：按月分表、提前 3 天，则月末前 3 天内返回 true。
   */
  shouldPrepare(at: Date = this.now()): { ready: boolean; target: Date; reason: string } {
    const unit = detectPeriodUnit(this.format);
    const currentStart = startOfPeriod(at, unit);
    const nextStart = addPeriod(currentStart, unit);
    const currentEnd = new Date(nextStart.getTime() - 1);
    const remainingMs = currentEnd.getTime() - at.getTime();
    if (remainingMs > this.prepareAdvanceMs) {
      return {
        ready: false,
        target: nextStart,
        reason: `${Math.round(remainingMs / 3_600_000)}h until period end exceeds advance window`,
      };
    }
    return { ready: true, target: nextStart, reason: 'within advance window' };
  }

  /** 后台循环每个 tick 调用：需要则建表，否则跳过。 */
  async prepareNextPeriod(at: Date = this.now()): Promise<PreparationResult> {
    const decision = this.shouldPrepare(at);
    if (!decision.ready) return { skipped: true, reason: decision.reason };
    return { skipped: false, ...(await this.prepareFor(decision.target)) };
  }

  /** 为包含 `date` 的那一期建表（幂等）。 */
  async prepareFor(date: Date): Promise<PreparationOutcome> {
    const outcome: PreparationOutcome = {
      period: formatShardSuffix(date, this.format),
      target: date.toISOString(),
      created: [],
      existing: [],
      failed: [],
    };

    for (const definition of this.registry.all()) {
      const sharded = shardedTableName(definition, date);
      try {
        if (this.checkExists && (await this.tableExists(sharded))) {
          outcome.existing.push(sharded);
          continue;
        }
        await this.database.query(this.buildCreateSql(definition, sharded));
        outcome.created.push(sharded);
        this.logger.info('sharded table created', { table: sharded, base: definition.table });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outcome.failed.push({ table: sharded, error: message });
        // 单表失败不能中断其它表，也不能让后台循环整体崩溃
        this.logger.error(err, 'sharded table preparation failed', { table: sharded });
      }
    }
    return outcome;
  }

  private buildCreateSql(definition: ShardDefinition, shardedTable: string): string {
    if (definition.createSql) return definition.createSql(this.dialect, shardedTable, definition.table);
    return defaultCreateSql(this.dialect, shardedTable, definition.table);
  }

  /** 表是否存在。各方言系统表位置不同，占位符也不同。 */
  async tableExists(name: string): Promise<boolean> {
    switch (this.dialect) {
      case 'mysql': {
        const result = await this.database.query<{ table_name?: string }>(
          'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
          [name],
        );
        return result.rows.length > 0;
      }
      case 'sqlite': {
        const result = await this.database.query<{ name?: string }>(
          'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
          ['table', name],
        );
        return result.rows.length > 0;
      }
      case 'postgres':
      default: {
        const result = await this.database.query<{ name?: string | null }>('SELECT to_regclass($1) AS name', [name]);
        const value = result.rows[0]?.name;
        return result.rows.length > 0 && value !== null && value !== undefined;
      }
    }
  }
}

/**
 * 把 TablePreparer 挂进 ServiceManager 的守护服务。
 *
 * 循环逻辑与建表逻辑分开，是为了让建表本身可以脱离生命周期被单测。
 * 定时器 unref()，否则进程会因为一个后台巡检而无法退出。
 */
export class TablePreparerService extends AbstractService {
  override readonly name = 'table-preparer';
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly preparer: TablePreparer,
    private readonly checkIntervalMs: number,
  ) {
    super();
  }

  protected async onStart(_ctx: ServiceContext): Promise<void> {
    this.stopped = false;
    // 启动时先跑一次：进程重启后可能正好处在准备窗口内
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    this.inFlight = this.preparer
      .prepareNextPeriod()
      .catch(() => {
        /* 已在 preparer 内部记录，循环不因单次失败退出 */
      })
      .finally(() => {
        this.ticking = false;
      });
    await this.inFlight;
  }

  protected async onStop(_ctx: ServiceContext): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }
}
