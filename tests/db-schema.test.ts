/**
 * `database.schema` 必须真的落到「连接」和「迁移」两处。
 *
 * 这两处都曾经漏过，而且漏了都不报错：
 *   - 连接侧：`pg` 不认 URL 里的 `schema=` 参数（那是 Prisma 的约定），
 *     只配 URL 的话 search_path 永远是默认的 `"$user", public`；
 *   - 迁移侧：`schema_migrations` 是在任何迁移之前建的，此时站点 schema
 *     还不存在，Postgres 会**静默**回落到 search_path 里第一个存在的 schema（public）。
 *
 * 结果都是「表建到了别的地方」，服务照常跑 —— 所以只能靠测试盯着。
 */
import { describe, expect, it } from 'vitest';
import { requireSafeSchema, searchPathOptions } from '../src/infra/database/pg-schema.js';
import { Migrator } from '../src/infra/migrate/migrator.js';
import { createLogger } from '../src/shared/logger.js';
import { StubDatabase } from './helpers/stub-infra.js';

const logger = createLogger({ level: 'silent', format: 'json' });

describe('searchPathOptions', () => {
  it('站点 schema 追加 public：扩展函数通常装在 public 里', () => {
    expect(searchPathOptions('site0xui')).toEqual({ options: '-c search_path=site0xui,public' });
  });

  it('public 与空值不需要设置 search_path', () => {
    expect(searchPathOptions('public')).toEqual({});
    expect(searchPathOptions(undefined)).toEqual({});
    expect(searchPathOptions('   ')).toEqual({});
  });

  it('非法标识符直接抛错，不回退（回退＝表建到别处）', () => {
    expect(() => searchPathOptions('site0xui; DROP TABLE users')).toThrow(/invalid database\.schema/);
    expect(() => searchPathOptions('has-dash')).toThrow(/invalid database\.schema/);
    expect(() => requireSafeSchema('1abc')).toThrow(/invalid database\.schema/);
  });
});

describe('Migrator 的 schema 引导', () => {
  function migratorWith(schema: string | undefined, dialect: 'postgres' | 'mysql' = 'postgres') {
    const db = new StubDatabase();
    const migrator = new Migrator({
      database: db,
      dialect,
      directory: '/tmp/does-not-matter',
      schema,
      logger,
    });
    return { db, migrator };
  }

  it('建 schema_migrations 之前先建 schema', async () => {
    const { db, migrator } = migratorWith('site0xui');
    await migrator.ensureTable();

    const createSchema = db.queries.findIndex((q) => /CREATE SCHEMA IF NOT EXISTS site0xui/.test(q.sql));
    const createTable = db.queries.findIndex((q) => /CREATE TABLE IF NOT EXISTS schema_migrations/.test(q.sql));

    expect(createSchema).toBeGreaterThanOrEqual(0);
    expect(createTable).toBeGreaterThan(createSchema);
  });

  it('public / 未配置 schema 时不发多余 DDL', async () => {
    for (const schema of ['public', undefined]) {
      const { db, migrator } = migratorWith(schema);
      await migrator.ensureTable();
      expect(db.queries.some((q) => /CREATE SCHEMA/.test(q.sql))).toBe(false);
    }
  });

  it('mysql 方言不做 Postgres 的 schema 处理', async () => {
    const { db, migrator } = migratorWith('site0xui', 'mysql');
    await migrator.ensureTable();
    expect(db.queries.some((q) => /CREATE SCHEMA/.test(q.sql))).toBe(false);
  });

  it('配了非法 schema 名时构造阶段就失败', () => {
    expect(() => migratorWith('bad name')).toThrow(/invalid database\.schema/);
  });
});
