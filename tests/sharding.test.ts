/**
 * 分表与 TablePreparer 的测试。
 *
 * 重点不是「SQL 字符串长什么样」，而是三条容易写错、写错了又只在生产暴露的规则：
 *  1. 提前量：只有临近期末才建下期表，平时不能无脑建
 *  2. 幂等：表已存在时不重复建（否则后台巡检会持续刷事件）
 *  3. 隔离：某张表建失败，不能拖垮其它表和后台循环
 * 另外用真实 better-sqlite3 跑一遍端到端，证明「非 Postgres 驱动真的能用」。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/infra/database/index.js';
import { ShardRegistry, formatShardSuffix, monthlySuffix, shardedTableName } from '../src/infra/database/sharding.js';
import { TablePreparer, TablePreparerService, detectPeriodUnit } from '../src/infra/database/table-preparer.js';
import { defaultConfig } from '../src/config/schema.js';
import { createLogger } from '../src/shared/logger.js';
import { StubDatabase } from './helpers/stub-infra.js';

const DAY = 86_400_000;
const silentLogger = createLogger({ level: 'silent', format: 'text', output: 'stdout' });

function makePreparer(db: StubDatabase, overrides: Partial<ConstructorParameters<typeof TablePreparer>[0]> = {}) {
  const registry = new ShardRegistry().register(
    { table: 'events' },
    { table: 'audit_logs', suffix: monthlySuffix('YYYY_MM') },
  );
  return new TablePreparer({
    database: db,
    registry,
    logger: silentLogger,
    checkIntervalMs: DAY,
    prepareAdvanceMs: 3 * DAY,
    format: 'YYYYMM',
    checkExists: true,
    ...overrides,
  });
}

describe('分表命名', () => {
  it('按格式替换日期令牌，其余字符保留', () => {
    const date = new Date('2026-03-05T09:07:00Z');
    expect(formatShardSuffix(date, 'YYYYMM')).toBe('202603');
    expect(formatShardSuffix(date, 'YYYY_MM')).toBe('2026_03');
    expect(formatShardSuffix(date, 'YYMMDD')).toBe('260305');
    // 本机时区影响 HH，这里只验证长度与令牌被替换
    expect(formatShardSuffix(date, 'YYYYMMDDHH')).toHaveLength(10);
  });

  it('非法日期直接报错，而不是生成一张叫 events_NaN 的表', () => {
    expect(() => formatShardSuffix(new Date('nope'), 'YYYYMM')).toThrow(/invalid date/);
  });

  it('从格式推断周期：最细粒度决定周期', () => {
    expect(detectPeriodUnit('YYYYMM')).toBe('month');
    expect(detectPeriodUnit('YYYYMMDD')).toBe('day');
    expect(detectPeriodUnit('YYYYMMDDHH')).toBe('hour');
  });

  it('注册表拒绝重复注册与非法表名', () => {
    const registry = new ShardRegistry().register({ table: 'events' });
    expect(() => registry.register({ table: 'events' })).toThrow(/already registered/);
    expect(() => registry.register({ table: 'events; DROP TABLE users' })).toThrow(/unsafe/);
  });

  it('分表名带上前缀后缀；非法后缀不会拼进 SQL', () => {
    const def = { table: 'events', suffix: () => '202603' };
    expect(shardedTableName(def, new Date())).toBe('events_202603');
    expect(() => shardedTableName({ table: 'events', suffix: () => '2026-03' }, new Date())).toThrow(/unsafe/);
  });
});

describe('TablePreparer：提前量', () => {
  it('距离期末还早时不建表', async () => {
    const db = new StubDatabase();
    const preparer = makePreparer(db);
    const result = await preparer.prepareNextPeriod(new Date('2026-03-01T00:00:00Z'));
    expect(result).toMatchObject({ skipped: true });
    expect(db.queries).toHaveLength(0);
  });

  it('进入提前窗口后，为「下一期」建表', async () => {
    const db = new StubDatabase(() => ({ rows: [{ name: null }], rowCount: 1 }));
    const preparer = makePreparer(db);
    const result = await preparer.prepareNextPeriod(new Date('2026-03-30T00:00:00Z'));
    expect(result).toMatchObject({ skipped: false });
    if (result.skipped) throw new Error('unreachable');
    // 3 月 30 日准备的是 4 月的表，而不是当月的
    expect(result.period).toBe('202604');
    expect(result.created).toEqual(['events_202604', 'audit_logs_2026_04']);
    expect(db.queries.some((q) => q.sql.includes('CREATE TABLE IF NOT EXISTS "events_202604"'))).toBe(true);
  });
});

describe('TablePreparer：幂等与隔离', () => {
  it('表已存在时跳过，不执行 CREATE', async () => {
    // 存在性检查返回非空 → 两张表都存在
    const db = new StubDatabase(() => ({ rows: [{ name: 'events_202604' }], rowCount: 1 }));
    const preparer = makePreparer(db);
    const outcome = await preparer.prepareFor(new Date('2026-04-01T00:00:00Z'));
    expect(outcome.existing).toEqual(['events_202604', 'audit_logs_2026_04']);
    expect(outcome.created).toEqual([]);
    expect(db.queries.every((q) => !q.sql.startsWith('CREATE'))).toBe(true);
  });

  it('一张表失败不影响其它表，也不会抛穿后台循环', async () => {
    const db = new StubDatabase((sql) => {
      if (sql.includes('events_202604')) throw new Error('permission denied');
      return { rows: [{ name: null }], rowCount: 1 };
    });
    const preparer = makePreparer(db);
    const outcome = await preparer.prepareFor(new Date('2026-04-01T00:00:00Z'));
    expect(outcome.failed.map((f) => f.table)).toEqual(['events_202604']);
    expect(outcome.created).toEqual(['audit_logs_2026_04']);
  });

  it('postgres 用 CREATE TABLE ... (LIKE ... INCLUDING ALL)', async () => {
    const db = new StubDatabase(() => ({ rows: [{ name: null }], rowCount: 1 }));
    await makePreparer(db).prepareFor(new Date('2026-04-01T00:00:00Z'));
    expect(db.queries[1]?.sql).toContain('(LIKE "events" INCLUDING ALL)');
  });
});

describe('TablePreparerService 生命周期', () => {
  it('启动时执行一次，停止后不再执行', async () => {
    let calls = 0;
    const fakePreparer = {
      prepareNextPeriod: async () => {
        calls += 1;
        return { skipped: true, reason: 'test' } as const;
      },
    } as unknown as TablePreparer;

    const service = new TablePreparerService(fakePreparer, 10);
    const ctx = { logger: silentLogger } as unknown as Parameters<typeof service.start>[0];
    await service.start(ctx);
    expect(calls).toBe(1);
    await service.stop(ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
  });
});

describe('非 Postgres 驱动：真实 sqlite 端到端', () => {
  const opened: Array<Awaited<ReturnType<typeof createDatabase>>> = [];
  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close();
  });

  it('sqlite 驱动（better-sqlite3）能建表、插数、查询', async (testCtx) => {
    const config = { ...defaultConfig().database, driver: 'sqlite' as const, name: ':memory:' };
    let db: Awaited<ReturnType<typeof createDatabase>>;
    try {
      db = await createDatabase(config, 'test');
    } catch (err) {
      // 可选依赖没装成功时跳过，而不是让整套测试变红
      if (err instanceof Error && err.message.includes('optional dependency')) {
        testCtx.skip();
        return;
      }
      throw err;
    }
    opened.push(db);

    await db.query('CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT)');
    await db.query('INSERT INTO events (payload) VALUES (?)', ['hello']);
    const result = await db.query<{ payload: string }>('SELECT payload FROM events');
    expect(result.rows).toEqual([{ payload: 'hello' }]);
    await db.ping();
  });

  it('sqlite + TablePreparer：分表按 sqlite 方言建出来且可写', async (testCtx) => {
    const config = { ...defaultConfig().database, driver: 'sqlite' as const, name: ':memory:' };
    let db: Awaited<ReturnType<typeof createDatabase>>;
    try {
      db = await createDatabase(config, 'test');
    } catch (err) {
      if (err instanceof Error && err.message.includes('optional dependency')) {
        testCtx.skip();
        return;
      }
      throw err;
    }
    opened.push(db);

    await db.query('CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT)');
    const preparer = makePreparer(db as unknown as StubDatabase, { format: 'YYYYMM' });
    const outcome = await preparer.prepareFor(new Date('2026-04-01T00:00:00Z'));
    // sqlite 没有 CREATE TABLE LIKE，默认走 AS SELECT，因此 events 这张会「建成」
    expect(outcome.created).toContain('events_202604');

    await db.query('INSERT INTO events_202604 (payload) VALUES (?)', ['sharded']);
    const rows = await db.query<{ payload: string }>('SELECT payload FROM events_202604');
    expect(rows.rows).toEqual([{ payload: 'sharded' }]);
    // 幂等：第二次巡检应当识别为已存在
    expect(await preparer.tableExists('events_202604')).toBe(true);
  });
});
