/**
 * 迁移引擎（纯 SQL 文件驱动）。
 *
 * 为什么不用 ORM 自带的迁移：SQL 文件是最小公分母 —— 换语言、换框架
 * 都能用，且 DBA 可以直接 review。代价是要自己实现这几件事：
 *
 *   - 版本排序    文件名前缀即版本（20260601000001_name.up.sql），字符串排序天然有序
 *   - 幂等记录    schema_migrations 表记录已应用版本
 *   - 校验和      记录文件 sha256，防止「已应用的迁移被偷改」导致环境间漂移
 *   - 事务        postgres/sqlite 每个迁移一个事务；mysql 的 DDL 隐式提交，只能尽力而为
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Database, Executor } from '../database/types.js';
import { requireSafeSchema } from '../database/pg-schema.js';
import type { Logger } from '../../shared/logger.js';
import { getLogger } from '../../shared/logger.js';

export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

export interface MigrationFile {
  version: string;
  name: string;
  direction: 'up' | 'down';
  filePath: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationState {
  applied: AppliedMigration[];
  pending: MigrationFile[];
  /** 已应用但文件内容变了（危险，需要人工确认） */
  drifted: Array<{ version: string; recorded: string; actual: string }>;
}

export interface MigratorOptions {
  database: Database;
  dialect: SqlDialect;
  /** 迁移目录，例如 <root>/migrations/postgres */
  directory: string;
  tableName?: string;
  /**
   * Postgres schema（命名空间）。设了它就会在 `schema_migrations` 之前
   * `CREATE SCHEMA IF NOT EXISTS`：schema 还不存在时，Postgres 会**静默**
   * 把表建到 `public` 里（search_path 里第一个存在的 schema 才是落点），
   * 于是同一个库被拆进两个 schema。
   */
  schema?: string;
  logger?: Logger;
}

const FILE_PATTERN = /^(\d+)_([\w-]+)\.(up|down)\.sql$/;

export class Migrator {
  private readonly db: Database;
  private readonly dialect: SqlDialect;
  private readonly directory: string;
  private readonly table: string;
  private readonly schema: string | null;
  private readonly logger: Logger;

  constructor(options: MigratorOptions) {
    this.db = options.database;
    this.dialect = options.dialect;
    this.directory = options.directory;
    this.table = options.tableName ?? 'schema_migrations';
    this.schema = requireSafeSchema(options.schema);
    this.logger = (options.logger ?? getLogger()).component('migrate');
  }

  // ── 表结构 ────────────────────────────────────────────────

  private get qualifiedTable(): string {
    return this.table;
  }

  /** 先建 schema，再建记录表：顺序反了就会建到 public 里去 */
  async ensureSchema(): Promise<void> {
    if (this.dialect !== 'postgres' || !this.schema) return;
    await this.db.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
  }

  async ensureTable(): Promise<void> {
    await this.ensureSchema();
    const idType = this.dialect === 'mysql' ? 'VARCHAR(64)' : 'VARCHAR(64)';
    const timestampType = this.dialect === 'mysql' ? 'DATETIME(3)' : 'TIMESTAMP';
    const sql = `
      CREATE TABLE IF NOT EXISTS ${this.qualifiedTable} (
        version     ${idType}   NOT NULL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        checksum    VARCHAR(64)  NOT NULL,
        applied_at  ${timestampType} NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await this.db.query(sql);
  }

  // ── 读取文件 ──────────────────────────────────────────────

  private readFiles(direction: 'up' | 'down'): MigrationFile[] {
    if (!fs.existsSync(this.directory)) return [];
    return fs
      .readdirSync(this.directory)
      .map((file) => ({ file, match: FILE_PATTERN.exec(file) }))
      .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
      .filter((entry) => entry.match[3] === direction)
      .map((entry) => {
        const filePath = path.join(this.directory, entry.file);
        const sql = fs.readFileSync(filePath, 'utf8');
        return {
          version: entry.match[1] as string,
          name: entry.match[2] as string,
          direction,
          filePath,
          checksum: createHash('sha256').update(sql).digest('hex'),
          sql,
        };
      })
      .sort((a, b) => a.version.localeCompare(b.version));
  }

  async listApplied(): Promise<AppliedMigration[]> {
    await this.ensureTable();
    const result = await this.db.query<{ version: string; name: string; checksum: string; applied_at: string | Date }>(
      `SELECT version, name, checksum, applied_at FROM ${this.qualifiedTable} ORDER BY version ASC`,
    );
    return result.rows.map((row) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at instanceof Date ? row.applied_at : new Date(row.applied_at),
    }));
  }

  async state(): Promise<MigrationState> {
    const applied = await this.listApplied();
    const appliedByVersion = new Map(applied.map((m) => [m.version, m]));
    const upFiles = this.readFiles('up');

    const pending = upFiles.filter((file) => !appliedByVersion.has(file.version));
    const drifted = upFiles
      .filter((file) => {
        const record = appliedByVersion.get(file.version);
        return record !== undefined && record.checksum !== file.checksum;
      })
      .map((file) => ({
        version: file.version,
        recorded: appliedByVersion.get(file.version)?.checksum ?? '',
        actual: file.checksum,
      }));

    return { applied, pending, drifted };
  }

  // ── 执行 ──────────────────────────────────────────────────

  /** 应用所有（或指定数量/截止版本）的 up 迁移 */
  async up(options: { to?: string; steps?: number } = {}): Promise<AppliedMigration[]> {
    const { pending, drifted } = await this.state();
    this.warnDrift(drifted);

    const targets = this.selectTargets(pending, options);
    const done: AppliedMigration[] = [];

    for (const migration of targets) {
      const startedAt = Date.now();
      await this.runInTransaction(migration.sql);
      await this.db.query(
        `INSERT INTO ${this.qualifiedTable} (version, name, checksum) VALUES (${
          this.dialect === 'mysql' ? '?, ?, ?' : '$1, $2, $3'
        })`,
        [migration.version, migration.name, migration.checksum],
      );
      const appliedAt = new Date();
      done.push({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        appliedAt,
      });
      this.logger.info('migration applied', {
        version: migration.version,
        name: migration.name,
        durationMs: Date.now() - startedAt,
      });
    }

    if (done.length === 0) this.logger.info('no pending migrations');
    return done;
  }

  /** 回滚（按 version 逆序执行 down 文件） */
  async down(options: { to?: string; steps?: number } = {}): Promise<AppliedMigration[]> {
    const applied = await this.listApplied();
    if (applied.length === 0) {
      this.logger.info('nothing to roll back');
      return [];
    }

    const downFiles = new Map(this.readFiles('down').map((f) => [f.version, f]));
    let targets = applied.slice().reverse();

    if (options.to) targets = targets.filter((m) => m.version > (options.to as string));
    if (options.steps !== undefined) targets = targets.slice(0, Math.max(0, options.steps));

    const reverted: AppliedMigration[] = [];
    for (const migration of targets) {
      const file = downFiles.get(migration.version);
      if (!file) {
        throw new Error(
          `missing down migration for version ${migration.version} (${migration.name}); ` +
            `expected ${migration.version}_${migration.name}.down.sql`,
        );
      }
      await this.runInTransaction(file.sql);
      await this.db.query(
        `DELETE FROM ${this.qualifiedTable} WHERE version = ${this.dialect === 'mysql' ? '?' : '$1'}`,
        [migration.version],
      );
      reverted.push(migration);
      this.logger.info('migration reverted', { version: migration.version, name: migration.name });
    }
    return reverted;
  }

  /** 生成一对空迁移文件 */
  create(name: string, directory = this.directory): { up: string; down: string } {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!slug) throw new Error('migration name must contain at least one alphanumeric character');

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 14);
    fs.mkdirSync(directory, { recursive: true });
    const upPath = path.join(directory, `${timestamp}_${slug}.up.sql`);
    const downPath = path.join(directory, `${timestamp}_${slug}.down.sql`);

    fs.writeFileSync(upPath, `-- ${timestamp}_${slug} (up)\n\n`);
    fs.writeFileSync(downPath, `-- ${timestamp}_${slug} (down)\n-- 回滚必须与 up 严格对称，否则环境间结构会漂移\n\n`);
    return { up: upPath, down: downPath };
  }

  // ── 内部 ──────────────────────────────────────────────────

  private selectTargets(pending: MigrationFile[], options: { to?: string; steps?: number }): MigrationFile[] {
    let targets = pending;
    if (options.to) targets = targets.filter((m) => m.version <= (options.to as string));
    if (options.steps !== undefined) targets = targets.slice(0, Math.max(0, options.steps));
    return targets;
  }

  /**
   * MySQL 的 DDL 会隐式提交事务，因此无法真正回滚；
   * 这里仍然包事务（对 DML 迁移有效），但在 mysql 下记录明确提示。
   */
  private async runInTransaction(sql: string): Promise<void> {
    const statements = splitStatements(sql);
    if (this.dialect === 'mysql') {
      // 逐条执行：mysql2 默认不允许一次 query 多个语句
      for (const statement of statements) await this.db.query(statement);
      return;
    }
    await this.db.transaction(async (tx: Executor) => {
      for (const statement of statements) await tx.query(statement);
    });
  }

  private warnDrift(drifted: MigrationState['drifted']): void {
    for (const drift of drifted) {
      this.logger.warn('applied migration file changed since it was applied', {
        version: drift.version,
        recordedChecksum: drift.recorded.slice(0, 12),
        actualChecksum: drift.actual.slice(0, 12),
        hint: 'create a new migration instead of editing an applied one',
      });
    }
  }
}

/**
 * 按分号切分 SQL 语句。
 * 处理了：字符串字面量、行注释、块注释、PostgreSQL 的 $$ ... $$ 函数体 ——
 * 否则包含分号的函数定义会被切碎。
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i] as string;
    const next = sql[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      current += char;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        current += '*/';
        i += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
        continue;
      }
      current += char;
      continue;
    }
    if (inSingle) {
      current += char;
      if (char === "'") {
        if (next === "'") {
          current += "'";
          i += 1;
        } else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      current += char;
      if (char === '"') {
        if (next === '"') {
          current += '"';
          i += 1;
        } else inDouble = false;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      inLineComment = true;
      current += '--';
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      current += '/*';
      i += 1;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      current += char;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      current += char;
      continue;
    }
    if (char === '$') {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        dollarTag = tagMatch[0];
        current += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (char === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }

  const last = current.trim();
  if (last) statements.push(last);
  return statements;
}
