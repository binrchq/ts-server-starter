/**
 * SQL 方言小工具。
 *
 * Database 抽象统一了「怎么执行」，但没统一「占位符怎么写」：
 * Postgres 用 `$1`，MySQL/SQLite 用 `?`。与其让每个仓储自己判断方言，
 * 不如统一按 `?` 书写，再在驱动边界翻译一次。
 *
 * 已知限制：这是**文本替换**，不理解 SQL 语法。所以模板里约定：
 *   - 字符串字面量中不要出现 `?`
 *   - Postgres 的 JSON 存在运算符 `?` 请改用 `jsonb_exists(col, 'key')`
 *     （`?` 在 node-postgres 里本来也会和参数绑定冲突）
 * 这两条都能在 code review 时一眼查出来，比引入一个 SQL parser 划算。
 */
import type { DatabaseDriver } from './types.js';

export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

export function dialectOf(driver: DatabaseDriver): SqlDialect {
  switch (driver) {
    case 'postgres':
    case 'postgresql':
    case 'prisma':
      return 'postgres';
    case 'mysql':
      return 'mysql';
    case 'sqlite':
    case 'sqlite3':
      return 'sqlite';
    default:
      throw new Error(`driver "${String(driver)}" has no SQL dialect`);
  }
}

/** 把 `?` 占位符转换成目标方言的形式 */
export function bind(sql: string, dialect: SqlDialect): string {
  if (dialect !== 'postgres') return sql;
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/**
 * 生成多行 VALUES 片段，例如 `($1,$2),($3,$4)`。
 * 手写占位符下标是偏移量类 bug 的高发区，这里集中处理。
 */
export function valuesClause(rowCount: number, columnCount: number, dialect: SqlDialect): string {
  if (rowCount <= 0 || columnCount <= 0) throw new Error('valuesClause requires positive row/column counts');
  const rows: string[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < columnCount; col += 1) {
      const ordinal = row * columnCount + col + 1;
      cells.push(dialect === 'postgres' ? `$${ordinal}` : '?');
    }
    rows.push(`(${cells.join(', ')})`);
  }
  return rows.join(', ');
}
