/**
 * 迁移引擎的测试重点在 splitStatements：把整个 .sql 文件切成一条条语句，
 * 是「字符串里带分号」「函数体带 $$」这两类场景的重灾区。
 * 切错一次，线上就是半执行的迁移。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Migrator, splitStatements } from '../src/infra/migrate/migrator.js';
import { createLogger } from '../src/shared/logger.js';
import { StubDatabase } from './helpers/stub-infra.js';

const logger = createLogger({ level: 'silent', format: 'json' });

describe('splitStatements', () => {
  it('按分号切分并丢掉空语句', () => {
    const sql = 'CREATE TABLE a (id int);\n\n  ;\nCREATE TABLE b (id int);';
    expect(splitStatements(sql)).toEqual(['CREATE TABLE a (id int)', 'CREATE TABLE b (id int)']);
  });

  it('不切分字符串字面量里的分号', () => {
    const sql = "INSERT INTO t (v) VALUES ('a;b;c');\nSELECT 1";
    expect(splitStatements(sql)).toEqual(["INSERT INTO t (v) VALUES ('a;b;c')", 'SELECT 1']);
  });

  it('不切分双引号标识符里的分号', () => {
    const sql = 'CREATE TABLE "weird;name" (id int);';
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it('不切分注释里的分号', () => {
    const sql = '-- 说明; 这里不是语句结束\nSELECT 1;\n/* 块注释; 也不是 */\nSELECT 2;';
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('SELECT 1');
    expect(statements[1]).toContain('SELECT 2');
  });

  it('不切分 dollar-quoted 函数体里的分号', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$
BEGIN
  RETURN 1;
END;
$$ LANGUAGE plpgsql;
SELECT 1;`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('LANGUAGE plpgsql');
    expect(statements[0]).toContain('RETURN 1;');
  });

  it('转义引号不会提前结束字符串', () => {
    const sql = "INSERT INTO t VALUES ('it''s; fine');\nSELECT 1;";
    expect(splitStatements(sql)).toEqual(["INSERT INTO t VALUES ('it''s; fine')", 'SELECT 1']);
  });
});

describe('Migrator', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ts-starter-migrations-'));
    const dir = join(root, 'postgres');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '20260101000001_init.up.sql'), 'CREATE TABLE t (id int);');
    await writeFile(join(dir, '20260101000001_init.down.sql'), 'DROP TABLE t;');
    await writeFile(join(dir, '20260102000001_more.up.sql'), 'ALTER TABLE t ADD COLUMN n int;');
    await writeFile(join(dir, '20260102000001_more.down.sql'), 'ALTER TABLE t DROP COLUMN n;');
    // 这两个文件不该被识别
    await writeFile(join(dir, 'README.md'), 'not a migration');
    await writeFile(join(dir, 'badly-named.up.sql'), 'SELECT 1;');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  interface Recorded {
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }

  /**
   * 带状态的假库。
   *
   * 之前用「永远返回空结果」的替身，导致幂等性测试根本测不出问题 ——
   * 假库永远说「没有任何已应用迁移」，于是每次 up 都会重跑。
   * 这说明替身必须尊重被测代码依赖的那部分语义，否则测试给出的是假绿。
   */
  const makeMigrator = (
    seed: Recorded[] = [],
  ): {
    migrator: Migrator;
    records: Recorded[];
    ddl: string[];
  } => {
    const records: Recorded[] = [...seed];
    const ddl: string[] = [];
    const db = new StubDatabase(((sql: string, params: readonly unknown[] = []) => {
      if (sql.includes('FROM schema_migrations') && sql.includes('SELECT')) {
        return { rows: [...records], rowCount: records.length };
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        records.push({
          version: String(params[0]),
          name: String(params[1]),
          checksum: String(params[2]),
          applied_at: new Date(),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM schema_migrations')) {
        const index = records.findIndex((r) => r.version === String(params[0]));
        if (index >= 0) records.splice(index, 1);
        return { rows: [], rowCount: index >= 0 ? 1 : 0 };
      }
      // 迁移表自身的建表语句（CREATE TABLE IF NOT EXISTS schema_migrations）
      // 每次 up 都会执行且本就幂等，不计入业务 DDL
      if (sql.includes('schema_migrations')) return { rows: [], rowCount: 0 };
      // 其余都当作 DDL/业务语句记录，便于断言「是否真的执行过」
      ddl.push(sql);
      return { rows: [], rowCount: 0 };
    }) as never);
    const migrator = new Migrator({
      database: db,
      dialect: 'postgres',
      directory: join(root, 'postgres'),
      logger,
    });
    return { migrator, records, ddl };
  };

  it('只识别 <版本>_<名字>.<up|down>.sql，其余文件忽略', async () => {
    const { migrator } = makeMigrator();
    const state = await migrator.state();
    expect(state.pending.map((f) => f.version)).toEqual(['20260101000001', '20260102000001']);
    expect(state.pending[0]?.name).toBe('init');
  });

  it('按版本升序应用，并逐个写入 schema_migrations 记录', async () => {
    const { migrator, records, ddl } = makeMigrator();
    const applied = await migrator.up();
    expect(applied.map((m) => m.version)).toEqual(['20260101000001', '20260102000001']);
    expect(records.map((r) => r.version)).toEqual(['20260101000001', '20260102000001']);
    expect(ddl.some((sql) => sql.includes('CREATE TABLE t'))).toBe(true);
    expect(ddl.some((sql) => sql.includes('ADD COLUMN n'))).toBe(true);
  });

  it('重复 up 不再执行任何 DDL（幂等）', async () => {
    const { migrator, ddl } = makeMigrator();
    await migrator.up();
    const before = ddl.length;
    const second = await migrator.up();
    expect(second).toEqual([]);
    expect(ddl.length).toBe(before);
  });

  it('down 按逆序执行并删除记录', async () => {
    const { migrator, records, ddl } = makeMigrator();
    await migrator.up();
    const reverted = await migrator.down();
    expect(reverted.map((m) => m.version)).toEqual(['20260102000001', '20260101000001']);
    expect(records).toEqual([]);
    expect(ddl.some((sql) => sql.includes('DROP TABLE t'))).toBe(true);
  });

  it('down --to 只回滚指定版本之后的迁移', async () => {
    const { migrator, records } = makeMigrator();
    await migrator.up();
    const reverted = await migrator.down({ to: '20260101000001' });
    expect(reverted.map((m) => m.version)).toEqual(['20260102000001']);
    expect(records.map((r) => r.version)).toEqual(['20260101000001']);
  });

  it('校验和不匹配时报出 drift，而不是静默重跑', async () => {
    // 手动造一条「已记录但内容已被改动」的状态
    const { migrator } = makeMigrator([
      { version: '20260101000001', name: 'init', checksum: 'deadbeef', applied_at: new Date() },
    ]);
    const state = await migrator.state();
    expect(state.applied.map((m) => m.version)).toEqual(['20260101000001']);
    expect(state.drifted.map((d) => d.version)).toEqual(['20260101000001']);
    expect(state.pending.map((f) => f.version)).toEqual(['20260102000001']);
  });

  it('create() 生成带时间戳、带注释头的一对骨架迁移文件', async () => {
    const { migrator } = makeMigrator();
    const created = migrator.create('add_orders');
    // 返回的是绝对路径，断言 basename 才不依赖工作目录
    expect(basename(created.up)).toMatch(/^\d{14}_add_orders\.up\.sql$/);
    expect(basename(created.down)).toMatch(/^\d{14}_add_orders\.down\.sql$/);

    const up = await readFile(created.up, 'utf8');
    const down = await readFile(created.down, 'utf8');
    // 骨架里只有注释：避免空文件被误当成「已写好」
    expect(up).toContain('add_orders');
    expect(up).toContain('(up)');
    expect(down).toContain('(down)');

    await rm(created.up, { force: true });
    await rm(created.down, { force: true });
  });
});
