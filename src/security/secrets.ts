/**
 * 启动期机密强度校验。
 *
 * 目的：让「用默认密码上了生产」这类事故在启动时就失败，而不是等被扫到。
 * 规则刻意保守 —— 只拦明显不安全的取值，不强行规定复杂度算法。
 */
import type { Config } from '../config/schema.js';

export interface SecretProblem {
  name: string;
  reason: string;
}

const PLACEHOLDER_VALUES = new Set([
  '',
  'password',
  'changeme',
  'change-me',
  'secret',
  'your-secret-key',
  'your-32-character-plus-secret-key-change-me',
  'admin',
  '123456',
  'test',
  'todo',
]);

export interface SecretRule {
  /** 展示名，例如 security.session_secret */
  name: string;
  value: string | undefined;
  minLength: number;
  /** 是否允许为空（例如未启用对应功能时） */
  required: boolean;
}

export function collectSecretProblems(rules: SecretRule[]): SecretProblem[] {
  const problems: SecretProblem[] = [];
  for (const rule of rules) {
    const value = (rule.value ?? '').trim();
    if (!value) {
      if (rule.required) problems.push({ name: rule.name, reason: 'is required but empty' });
      continue;
    }
    if (PLACEHOLDER_VALUES.has(value.toLowerCase())) {
      problems.push({ name: rule.name, reason: 'still uses a placeholder value' });
      continue;
    }
    if (value.length < rule.minLength) {
      problems.push({ name: rule.name, reason: `must be at least ${rule.minLength} characters` });
    }
  }
  return problems;
}

/**
 * 校验当前配置。生产环境（environment=prod）下有问题直接抛错；
 * 其余环境只返回问题列表，由调用方 warning。
 */
export function assertSecretsSafe(cfg: Config, opts: { throwOnProblem: boolean }): SecretProblem[] {
  const rules: SecretRule[] = [
    {
      name: 'security.session_secret',
      value: cfg.security.sessionSecret,
      minLength: 32,
      required: cfg.security.enforceSecrets,
    },
    { name: 'database.password', value: cfg.database.password, minLength: 8, required: false },
    { name: 'redis.password', value: cfg.redis.password, minLength: 8, required: false },
  ];

  const problems = collectSecretProblems(rules);
  if (problems.length > 0 && opts.throwOnProblem) {
    throw new Error(
      `refusing to start: insecure secrets detected\n  - ${problems
        .map((p) => `${p.name} ${p.reason}`)
        .join('\n  - ')}`,
    );
  }
  return problems;
}
