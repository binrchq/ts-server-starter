/**
 * Postgres schema（命名空间）在连接与迁移两侧的一致处理。
 *
 * 为什么值得单独一个文件：`database.schema` 配错或没生效时，表现是
 * 「表建到了 public 里」——服务照常跑，只有 `\dt` 或者某天 two schema 都有
 * 半张表的时候才会发现。所以两处必须用同一套判定：
 *   1. 连接：把 schema 写进 `search_path`（pg **不认** URL 里的 `schema=`，那是 Prisma 的约定）
 *   2. 迁移：在建 `schema_migrations` 之前先 `CREATE SCHEMA IF NOT EXISTS`
 *      （否则 schema 尚不存在，DDL 会静默回落到 public）
 */

/** Postgres 标识符白名单。schema 名来自配置，但拼进 SQL 前仍要校验：这是注入面 */
const PG_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSafePgIdentifier(value: string): boolean {
  return PG_IDENTIFIER.test(value);
}

/**
 * 取出「需要特殊处理的 schema 名」：`public` 与空值都不用管。
 * 非法标识符直接抛错 —— 不猜、不回退，因为回退的后果是表建到别的地方。
 */
export function requireSafeSchema(schema: string | undefined): string | null {
  const name = schema?.trim();
  if (!name || name === 'public') return null;
  if (!PG_IDENTIFIER.test(name)) throw new Error(`invalid database.schema: ${name}`);
  return name;
}

/**
 * 连接参数里的 `search_path`。
 *
 * 保留 `public` 在末尾：扩展（如 `pgcrypto`）通常装在 public 里，
 * 只写站点 schema 会让 `gen_random_uuid()` 这类调用找不到函数。
 */
export function searchPathOptions(schema: string | undefined): { options?: string } {
  const name = requireSafeSchema(schema);
  return name ? { options: `-c search_path=${name},public` } : {};
}
