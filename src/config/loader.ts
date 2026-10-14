/**
 * 配置加载：默认值 ← config.yaml ← 环境变量 ← CLI 参数（后者覆盖前者）。
 *
 * 关键约定：
 *  - YAML 用小写下划线（read_timeout），加载时统一 camelize
 *  - 环境变量用双下划线表示层级：DATABASE__HOST=db  →  database.host
 *  - 只有默认配置树里已存在的路径才会被覆盖，避免拼错变量名静默注入垃圾字段
 *  - 常见的 12-factor 变量（DATABASE_URL / REDIS_URL / PORT）做别名映射
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configSchema, defaultConfig, type Config } from './schema.js';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface LoadConfigOptions {
  /** config.yaml 路径；不存在则只用默认值 + 环境变量 */
  configPath?: string;
  /** CLI 参数（最高优先级） */
  overrides?: DeepPartial<Config>;
  env?: NodeJS.ProcessEnv;
}

const ENV_ALIASES: Record<string, string[]> = {
  DATABASE_URL: ['database', 'url'],
  REDIS_URL: ['redis', 'url'],
  SESSION_SECRET: ['security', 'sessionSecret'],
  NODE_ENV: ['environment'],
  ENVIRONMENT: ['environment'],
  APP_NAME: ['app', 'name'],
  APP_VERSION: ['app', 'version'],
  PORT: ['server', 'port'],
  LOG_LEVEL: ['logging', 'level'],
  LOG_FORMAT: ['logging', 'format'],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** snake_case / kebab-case → camelCase，递归作用于对象键 */
function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [
      key.replace(/[_-](\w)/g, (_, c: string) => c.toUpperCase()),
      camelizeKeys(val),
    ]),
  );
}

/** deep merge（数组整体替换，不做元素级合并） */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value;
  }
  return out as T;
}

/**
 * 环境变量永远是字符串，因此必须按**目标字段当前的类型**做转换。
 *
 * 这里刻意不写「哪些字段是数字」的白名单：白名单一定会漏（新增 port 字段忘了加），
 * 而漏掉的后果是 zod 解析时抛一个和字段名无关的错，排查成本很高。
 * 直接看默认值的类型，新增字段自动获得正确的转换行为。
 */
function coerceToCurrent(raw: string, current: unknown): unknown {
  if (typeof current === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : current;
  }
  if (typeof current === 'boolean') return raw === 'true' || raw === '1' || raw === 'yes';
  if (Array.isArray(current)) {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return raw;
}

/**
 * 按路径写入配置树。
 * 只有默认配置里**已存在**的路径才允许写入 —— 拼错变量名（`SERVER__PROT`）
 * 会被静默忽略而不是塞进一个 zod 认不出的字段。
 */
function setAtPath(target: Record<string, unknown>, keys: string[], raw: string): boolean {
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (!isPlainObject(next)) return false;
    node = next;
  }
  const leaf = keys[keys.length - 1];
  if (leaf === undefined || !(leaf in node)) return false;
  node[leaf] = coerceToCurrent(raw, node[leaf]);
  return true;
}

/**
 * 把环境变量里能识别的项合并进配置（在默认树之上就地修改）。
 *
 * 顺序很重要，而且必须是**确定**的：`LOG_LEVEL` 与 `LOGGING__LEVEL` 指向同一个
 * 配置项，如果按 `Object.entries(process.env)` 的自然顺序处理，谁生效就取决于
 * 变量被写入 process.env 的先后（shell 变量在前，dotenv 后加的在后）——
 * 于是「我明明设了 LOG_LEVEL=silent」变成一个查不出原因的问题。
 *
 * 规则：通用形式（`A__B__C`）先应用，别名后应用 ⇒ **别名恒胜**。
 * 因为别名是为可读性提供的显式写法，用户写了它就说明意图明确。
 *
 * @returns 同一路径被两种写法同时覆盖时的冲突说明，交给调用方打日志
 */
/**
 * 包管理器 / 工具链注入的环境变量前缀。
 *
 * `npm_package_dependencies__prisma_adapter_pg` 里带 `__`，会被当成配置路径
 * 报一条「matches no known setting」——于是每次 `pnpm serve` 都吐一条假 WARN。
 * 假告警最贵的地方不是噪声，而是它会把真告警（键名拼错）淹掉。
 */
const TOOLING_ENV_PREFIXES = ['npm_', 'PNPM_', 'COREPACK_'] as const;

function isToolingEnvKey(key: string): boolean {
  return TOOLING_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function applyEnvOverrides(target: Record<string, unknown>, env: NodeJS.ProcessEnv): string[] {
  const setBy: Map<string, string> = new Map();
  const conflicts: string[] = [];

  const apply = (keys: string[], rawValue: string, sourceKey: string): void => {
    if (!setAtPath(target, keys, rawValue)) {
      // 拼错变量名（SERVER__PROT）以前是静默忽略的，结果是"我明明配了却没生效"
      // 这种最难查的问题。这里至少要说出来。只会对看起来像配置键的变量（含 `__`
      // 或命中别名表）报警，包管理器注入的变量（见 isToolingEnvKey）不算。
      conflicts.push(`${sourceKey} matches no known setting and was ignored`);
      return;
    }
    const path = keys.join('.');
    const previous = setBy.get(path);
    if (previous !== undefined) conflicts.push(`${previous} and ${sourceKey} both set ${path}; using ${sourceKey}`);
    setBy.set(path, sourceKey);
  };

  // 第一遍：通用形式 A__B__C
  const genericKeys: Array<{ key: string; value: string }> = [];
  const aliasKeys: Array<{ key: string; value: string; path: string[] }> = [];
  for (const [rawKey, rawValue] of Object.entries(env)) {
    if (rawValue === undefined) continue;
    // npm/pnpm 注入的变量不是配置；它们的名字里可能正好带 `__`
    if (isToolingEnvKey(rawKey)) continue;
    const alias = ENV_ALIASES[rawKey];
    if (alias) {
      aliasKeys.push({ key: rawKey, value: rawValue, path: alias });
      continue;
    }
    if (rawKey.includes('__')) genericKeys.push({ key: rawKey, value: rawValue });
  }

  for (const { key, value } of genericKeys) {
    const keys = key
      .split('__')
      .filter(Boolean)
      .map((segment) => segment.toLowerCase().replace(/[_-](\w)/g, (_, c: string) => c.toUpperCase()));
    apply(keys, value, key);
  }

  // 第二遍：别名（恒胜）
  for (const { key, value, path } of aliasKeys) {
    apply(path, value, key);
  }

  return conflicts;
}

export interface LoadedConfig {
  config: Config;
  /**
   * 非致命问题（例如同一配置项被两种环境变量写法同时设置）。
   *
   * 不在这里打日志：此刻日志器还没建出来，而它的级别正来自这份配置。
   * 交给 `wire()` 在建好日志器后输出。
   */
  warnings: string[];
  /**
   * 实际读到的配置文件（绝对路径）。没读到文件时为 `null`。
   *
   * 这一项存在的唯一理由是排查：「我明明改了配置」和「进程用的是另一份配置」
   * 从日志上看完全不同。曾经因为一份配置没被读进来，白查了一个多小时。
   */
  source: string | null;
}

/**
 * 解析要读哪个配置文件。
 *
 * 显式给了路径就必须存在 —— 之前是 `existsSync` 为假时静默跳过，
 * 于是 `--config ./configs/typo.yaml` 会「成功」地用默认配置启动，
 * 表现和「配置没生效」一模一样。宁可起不来，也不要跑错配置。
 */
function resolveConfigPath(explicit: string | undefined): string | null {
  if (!explicit) return null;

  const resolved = path.resolve(explicit);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `config file not found: ${resolved} (from ${explicit}); ` +
        '相对路径按当前工作目录解析，请确认路径或去掉 --config 使用默认值 + 环境变量',
    );
  }
  return resolved;
}

/** 加载并校验配置，同时返回可诊断信息 */
export function loadConfigDetailed(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const defaults = defaultConfig() as unknown as Record<string, unknown>;

  let fromFile: unknown = {};
  const source = resolveConfigPath(options.configPath ?? env.CONFIG_PATH);
  if (source) {
    fromFile = camelizeKeys(parseYaml(fs.readFileSync(source, 'utf8')) ?? {});
  }

  // 默认值 → 文件 → 环境变量 → CLI 参数
  const merged = deepMerge(defaults, fromFile as DeepPartial<Config>);
  const warnings = applyEnvOverrides(merged, env);
  const finalConfig = deepMerge(merged, options.overrides);

  return { config: configSchema.parse(finalConfig), warnings, source };
}

/**
 * 只回答一个问题：这些环境变量里，哪些名字配置系统不认识？
 *
 * 单独导出（而不是只靠 loadConfigDetailed 的 warnings）是因为它必须能在
 * **值非法**的情况下工作：docker-compose 里写的是 `${VAR:-default}` 占位符，
 * 直接校验会先因为枚举值非法抛错，于是「键名拼错」这条最重要的提示反而看不到 ——
 * 而键名拼错最贵（如把 server.trust_proxy 写成 SECURITY__TRUST_PROXY，
 * 表现是限流按代理 IP 统计，只有一条 WARN）。
 */
export function unknownEnvKeys(env: NodeJS.ProcessEnv): string[] {
  // 拿一份可抛弃的默认配置当靶子：setAtPath 就是靠「路径存不存在」判断键名的
  const scratch = structuredClone(defaultConfig()) as unknown as Record<string, unknown>;
  const marker = ' matches no known setting';
  return applyEnvOverrides(scratch, env)
    .filter((warning) => warning.includes(marker))
    .map((warning) => warning.slice(0, warning.indexOf(marker)));
}

/** 只要配置本身时的便捷入口 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  return loadConfigDetailed(options).config;
}
