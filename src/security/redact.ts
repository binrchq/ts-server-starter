/**
 * 日志/审计脱敏。
 *
 * 为什么必须做：日志是安全审计的第一现场，也是最容易泄露机密的地方 ——
 * 一个 `logger.info('login', { password })` 就把明文密码写进了日志系统。
 * 这里对「键名」做递归匹配（不区分大小写、忽略 -/_），命中即替换为 [REDACTED]。
 */

const REDACTED = '[REDACTED]';

export type Redactor = (value: unknown) => unknown;

export interface RedactorOptions {
  /** 需要打码的键名（不区分大小写、忽略 -/_ 差异） */
  keys: string[];
  /** 递归深度上限，防止深对象拖慢日志路径 */
  maxDepth?: number;
  /** 单个对象展开的键数上限，超出部分整体丢弃 */
  maxKeys?: number;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

/** 命中规则：完全相等，或键名以 sensitive 词根结尾/包含（如 x-api-key、userPassword） */
function isSensitive(key: string, needles: Set<string>): boolean {
  const normalized = normalizeKey(key);
  if (needles.has(normalized)) return true;
  for (const needle of needles) {
    if (needle.length >= 4 && normalized.endsWith(needle)) return true;
  }
  return false;
}

export function createRedactor(options: RedactorOptions): Redactor {
  const needles = new Set(options.keys.map(normalizeKey));
  const maxDepth = options.maxDepth ?? 6;
  const maxKeys = options.maxKeys ?? 100;

  const walk = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= maxDepth) return '[MAX_DEPTH]';
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) return value.slice(0, maxKeys).map((item) => walk(item, depth + 1, seen));

    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>).slice(0, maxKeys)) {
      out[key] = isSensitive(key, needles) ? REDACTED : walk(val, depth + 1, seen);
    }
    return out;
  };

  return (value) => walk(value, 0, new WeakSet());
}

/** HTTP 头脱敏：只保留白名单，其余全部折叠，避免把 Cookie/Authorization 写进日志 */
const SAFE_REQUEST_HEADERS = [
  'user-agent',
  'content-type',
  'content-length',
  'accept',
  'accept-language',
  'referer',
  'origin',
  'x-request-id',
  'x-forwarded-for',
];

export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of SAFE_REQUEST_HEADERS) {
    if (headers[name] !== undefined) out[name] = headers[name];
  }
  return out;
}

export { REDACTED };
