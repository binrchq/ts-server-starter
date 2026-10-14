/**
 * 部署文件里的环境变量键名必须真的存在。
 *
 * 这一类错误的代价特别不对称：拼错的键不会让部署失败，只会打一条 WARN，
 * 于是「配置了但没生效」被带进生产。真实案例：
 * `deploy/docker-compose.prod.yml` 里写了 `SECURITY__TRUST_PROXY: 'true'`，
 * 而正确路径是 `server.trust_proxy` —— 结果限流按前置 LB 的 IP 统计，
 * 所有用户共用一个桶，既能被单点打满、也能被用来绕过 per-IP 限制。
 *
 * 这里只校验**键名**，不校验值：compose 里的值是 `${VAR:-default}` 占位符，
 * 交给运行时展开；直接校验值会先因为枚举非法抛错，反而看不到键名问题。
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { unknownEnvKeys } from '../src/config/loader.js';

const ROOT = new URL('../', import.meta.url);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, ROOT), 'utf8');
}

/** 从 .env 风格文本里抽出 KEY=VALUE */
function envFileKeys(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) env[match[1]] = match[2] ?? '';
  }
  return env;
}

/** 从 compose 文件里抽出每个服务的 environment（支持 map 与 list 两种写法） */
function composeEnvs(raw: string): Array<{ service: string; env: Record<string, string> }> {
  const doc = parseYaml(raw) as { services?: Record<string, { environment?: unknown }> } | null;
  const found: Array<{ service: string; env: Record<string, string> }> = [];

  for (const [service, definition] of Object.entries(doc?.services ?? {})) {
    const environment = definition.environment;
    if (environment === undefined || environment === null) continue;

    const env: Record<string, string> = {};
    if (Array.isArray(environment)) {
      for (const item of environment) {
        const [key, ...rest] = String(item).split('=');
        if (key) env[key] = rest.join('=');
      }
    } else {
      for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
        env[key] = String(value);
      }
    }
    found.push({ service, env });
  }
  return found;
}

describe('部署与示例文件不能与配置 schema 脱节', () => {
  it('.env.example 里的键全部有效，且覆盖到关键配置段', () => {
    const env = envFileKeys(read('.env.example'));
    expect(Object.keys(env).length).toBeGreaterThan(20);
    expect(unknownEnvKeys(env)).toEqual([]);

    // 站点必需的几项：漏了它们新同事第一小时就会卡住
    for (const key of ['SERVER__PORT', 'DATABASE__SCHEMA', 'SECURITY__SESSION_SECRET', 'DEV_AUTH_BYPASS']) {
      expect(Object.keys(env)).toContain(key);
    }
  });

  it('docker-compose.yml 里的键全部有效', () => {
    const services = composeEnvs(read('docker-compose.yml'));
    expect(services.length).toBeGreaterThan(0);
    for (const { service, env } of services) {
      expect({ service, unknown: unknownEnvKeys(env) }).toEqual({ service, unknown: [] });
    }
  });

  it('deploy/docker-compose.prod.yml 里的键全部有效（trust_proxy 这类错只能靠它拦住）', () => {
    const services = composeEnvs(read('deploy/docker-compose.prod.yml'));
    expect(services.length).toBeGreaterThan(0);
    for (const { service, env } of services) {
      expect({ service, unknown: unknownEnvKeys(env) }).toEqual({ service, unknown: [] });
    }
  });

  it('包管理器注入的变量不算配置（否则每次 pnpm serve 都吐一条假 WARN）', () => {
    const env = {
      npm_package_name: 'ts-server-starter',
      npm_package_dependencies__prisma_adapter_pg: '7.9.0',
      npm_config_registry: 'https://registry.npmjs.org',
      PNPM_HOME: '/root/.local/share/pnpm',
      // 真拼错的仍然必须报出来，不能被前缀过滤误伤
      SERVER__TRUST_PROXYY: 'true',
    };
    expect(unknownEnvKeys(env)).toEqual(['SERVER__TRUST_PROXYY']);
  });
});
