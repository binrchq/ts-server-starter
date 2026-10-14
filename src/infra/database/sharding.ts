/**
 * 动态分表：定义、后缀算法与注册表。
 *
 * 对应 go-starter 的 `ShardableModel` + `model.ModelDependencies`。
 * Go 版靠反射从 struct 上取表名/字段；TS 没有运行时元数据，
 * 因此这里用**显式注册**：谁要分表、按什么规则命名，一目了然，
 * 不需要为「框架能识别我的 model」去写装饰器或搭一套元数据系统。
 *
 * 分表本身不改变查询方式：业务要知道「这个月的表叫什么」时调用
 * `shardedTableName()`，历史数据与实时数据用同一套命名规则。
 */

/** 支持的数据库方言（与 Database.dialect 的 sql 分支对应） */
export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

export interface ShardDefinition {
  /**
   * 基础表名（同时也是建表模板）。分表会是 `<table>_<suffix>`。
   * 必须是 `[A-Za-z_][A-Za-z0-9_]*` —— 这个名字会直接拼进 DDL。
   */
  table: string;
  /**
   * 由日期生成后缀。默认按月（`YYYYMM`）。
   * 自定义时务必保证「单调且无歧义」，否则会出现两张表抢同一个后缀。
   */
  suffix?: (date: Date) => string;
  /** 分片键列名。仅作文档/工具用途，运行时不会自动改写查询。 */
  field?: string;
  /**
   * 自定义建表语句。给无法 `CREATE TABLE LIKE` 的方言用。
   * 返回完整 SQL（须包含 IF NOT EXISTS）。不提供时按方言生成默认语句。
   *
   * `sqlite` 没有 `CREATE TABLE LIKE`，默认走
   * `CREATE TABLE ... AS SELECT ... WHERE 1=0`：能复制列名与近似类型，
   * 但**不复制主键/索引/约束**。生产用 sqlite 请显式提供本函数。
   */
  createSql?: (dialect: SqlDialect, shardedTable: string, baseTable: string) => string;
}

/** 表名/列名合法性。分表名会拼进 DDL，绝不能来自未校验的输入。 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSafeIdentifier(name: string, kind = 'identifier'): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`unsafe ${kind}: "${name}" must match ${SAFE_IDENTIFIER.source}`);
  }
}

/**
 * 把日期格式化成后缀。支持 YYYY / YY / MM / DD / HH，
 * 其余字符（`_`、`-` 等）原样保留。
 *
 *   formatShardSuffix(new Date('2026-03-05'), 'YYYYMM')   → '202603'
 *   formatShardSuffix(new Date('2026-03-05'), 'YYYY_MM_DD') → '2026_03_05'
 */
export function formatShardSuffix(date: Date, format: string): string {
  if (Number.isNaN(date.getTime())) throw new Error('formatShardSuffix: invalid date');
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return format.replace(/YYYY|YY|MM|DD|HH/g, (token) => {
    switch (token) {
      case 'YYYY':
        return String(date.getFullYear());
      case 'YY':
        return pad(date.getFullYear() % 100);
      case 'MM':
        return pad(date.getMonth() + 1);
      case 'DD':
        return pad(date.getDate());
      case 'HH':
        return pad(date.getHours());
      default:
        return token;
    }
  });
}

/** 便捷构造：按月分表的后缀生成器 */
export function monthlySuffix(format = 'YYYYMM'): (date: Date) => string {
  return (date) => formatShardSuffix(date, format);
}

/** 某个日期对应的分表名 */
export function shardedTableName(definition: ShardDefinition, date: Date): string {
  const suffix = definition.suffix ? definition.suffix(date) : formatShardSuffix(date, 'YYYYMM');
  const name = `${definition.table}_${suffix}`;
  assertSafeIdentifier(name, 'sharded table name');
  return name;
}

/**
 * 分表注册表。
 *
 * 是实例而不是模块级全局变量：测试之间不会互相污染，
 * 多个数据库也能各自持有一份。go-starter 用全局 `ModelDependencies`，
 * Node 里没有这个必要。
 */
export class ShardRegistry {
  private readonly definitions = new Map<string, ShardDefinition>();

  register(...definitions: ShardDefinition[]): this {
    for (const definition of definitions) {
      assertSafeIdentifier(definition.table, 'base table name');
      if (this.definitions.has(definition.table)) {
        throw new Error(`shard definition for table "${definition.table}" is already registered`);
      }
      this.definitions.set(definition.table, definition);
    }
    return this;
  }

  has(table: string): boolean {
    return this.definitions.has(table);
  }

  find(table: string): ShardDefinition | undefined {
    return this.definitions.get(table);
  }

  all(): ShardDefinition[] {
    return [...this.definitions.values()];
  }

  get size(): number {
    return this.definitions.size;
  }

  clear(): void {
    this.definitions.clear();
  }
}
