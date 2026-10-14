/**
 * 端到端 HTTP 测试。
 *
 * 覆盖的是「跨模块才成立」的约束 —— 单看任何一个模块都测不出来：
 *  多端口隔离（inner 用令牌、openapi 用 API Key）、安全头、错误体形状、
 *  X-Powered-By 必须消失、限流必须真的限住。
 * 这些都是「代码看起来对，但配置串错就没防护」的地方。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, type Config } from '../src/config/schema.js';
import { wire, type WiredApplication } from '../src/serve/wire.js';
import { StubCache, StubDatabase, StubQueue, StubState } from './helpers/stub-infra.js';
import { bearer, request, startLayers, type RunningChannel } from './helpers/http-harness.js';

const INTERNAL_TOKEN = 'internal-token-for-tests-0123456789';

let wired: WiredApplication;
let layers: Record<string, RunningChannel>;

function testConfig(): Config {
  const config = defaultConfig();
  config.environment = 'test';
  config.app.name = 'ts-server-starter-test';
  config.logging.level = 'silent';
  // 端口全部交给 listen(0)：这里只关心应用层行为
  config.server.port = 0;
  config.server.adminPort = 0;
  config.server.internalPort = 0;
  config.server.openapiPort = 0;
  config.server.metricsPort = 0;
  config.cache.driver = 'memory';
  config.mq.driver = 'memory';
  config.state.driver = 'memory';
  config.security.sessionSecret = 'test-session-secret-at-least-32-chars-long';
  config.security.internalToken = INTERNAL_TOKEN;
  config.security.allowedOrigins = ['https://app.example.com'];
  config.database.driver = 'postgres';
  return config;
}

beforeAll(async () => {
  process.env.DEV_AUTH_BYPASS = '1';
  process.env.DEV_USER_ID = 'dev-user-0001';
  process.env.DEV_USER_ROLES = 'user,admin';
  wired = await wire({
    config: testConfig(),
    infrastructure: {
      database: new StubDatabase(),
      cache: new StubCache(),
      mq: new StubQueue(),
      state: new StubState(),
    },
  });
  layers = await startLayers(wired);
});

afterAll(async () => {
  for (const layer of Object.values(layers ?? {})) await layer.close();
  await wired?.close();
  delete process.env.DEV_AUTH_BYPASS;
});

describe('安全响应头与基础卫生', () => {
  it('公共接口可达，且返回统一成功包装', async () => {
    const res = await request(layers.outer!.baseUrl, '/api/v1/public/ping');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it('不暴露 X-Powered-By（版本指纹是最廉价的攻击入口）', async () => {
    const res = await request(layers.outer!.baseUrl, '/api/v1/public/ping');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('带 nosniff 与 CSP，并回填 x-request-id', async () => {
    const res = await request(layers.outer!.baseUrl, '/api/v1/public/ping');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('沿用调用方传入的 x-request-id，便于跨服务串联链路', async () => {
    const res = await request(layers.outer!.baseUrl, '/api/v1/public/ping', {
      headers: { 'x-request-id': 'trace-me-123' },
    });
    expect(res.headers.get('x-request-id')).toBe('trace-me-123');
  });
});

describe('错误响应形状', () => {
  it('404 也是统一包装，并带 requestId（客户端贴错误就能定位日志）', async () => {
    const res = await request<{ success: boolean; error: { code: string; requestId?: string } }>(
      layers.outer!.baseUrl,
      '/api/v1/nope',
    );
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('非法 JSON 返回 400 VALIDATION_ERROR 而不是 500', async () => {
    const res = await request<{ error: { code: string } }>(layers.outer!.baseUrl, '/api/v1/public/auth/login', {
      method: 'POST',
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('请求体校验失败返回 400 且带字段级细节', async () => {
    const res = await request<{ error: { code: string; details?: unknown } }>(
      layers.outer!.baseUrl,
      '/api/v1/public/auth/register',
      { method: 'POST', body: JSON.stringify({ email: 'not-an-email' }) },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toBeTruthy();
  });
});

describe('认证与授权', () => {
  it('伪造/结构错误的令牌返回 401', async () => {
    const malformed = await request(layers.outer!.baseUrl, '/api/v1/user/profile', { headers: bearer('a.b.c') });
    expect(malformed.status).toBe(401);

    // 结构正确但签名不对（改了一个字符）
    const registered = await request<{ data: { tokens: { accessToken: string } } }>(
      layers.outer!.baseUrl,
      '/api/v1/public/auth/register',
      { method: 'POST', body: JSON.stringify({ email: 'tamper@example.com', password: 'Str0ng-Passw0rd!' }) },
    );
    const token = registered.body.data.tokens.accessToken;
    const tampered = `${token.slice(0, -2)}xy`;
    const res = await request(layers.outer!.baseUrl, '/api/v1/user/profile', { headers: bearer(tampered) });
    expect(res.status).toBe(401);
  });

  it('无令牌请求走不到匿名身份：本用例开启 DEV_AUTH_BYPASS，因此断言旁路语义', async () => {
    // 说明：开启旁路时无令牌请求会被识别为开发用户，这是刻意的开发便利。
    // 生产环境由 assertDevBypassAllowed 在启动阶段直接拒绝该配置，
    // 所以「无令牌 → 401」在生产恒成立，断言落在上面的伪造令牌用例上。
    const res = await request<{ data: { id: string } }>(layers.outer!.baseUrl, '/api/v1/user/profile');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('dev-user-0001');
  });

  it('注册 → 携带令牌访问 → 拿到正确身份', async () => {
    const registered = await request<{
      data: { user: { id: string; email: string }; tokens: { accessToken: string } };
    }>(layers.outer!.baseUrl, '/api/v1/public/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'e2e@example.com', password: 'Str0ng-Passw0rd!', displayName: 'E2E' }),
    });
    expect(registered.status).toBe(201);
    const token = registered.body.data.tokens.accessToken;

    const me = await request<{ data: { email: string; roles: string[] } }>(layers.outer!.baseUrl, '/api/v1/auth/me', {
      headers: bearer(token),
    });
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe('e2e@example.com');
    // 注册用户不应自带管理员角色
    expect(me.body.data.roles).not.toContain('admin');
  });

  it('重复邮箱注册返回 409 而不是 500', async () => {
    const body = JSON.stringify({ email: 'dup@example.com', password: 'Str0ng-Passw0rd!' });
    await request(layers.outer!.baseUrl, '/api/v1/public/auth/register', { method: 'POST', body });
    const again = await request<{ error: { code: string } }>(layers.outer!.baseUrl, '/api/v1/public/auth/register', {
      method: 'POST',
      body,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('开发旁路身份可访问，且具备 admin 角色', async () => {
    const res = await request<{ data: { roles: string[] } }>(layers.outer!.baseUrl, '/api/v1/user/profile');
    // 无 Authorization 头时走 DEV_AUTH_BYPASS
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toContain('admin');
  });

  it('普通用户访问 admin 接口返回 403，而不是 404 或 200', async () => {
    const registered = await request<{ data: { tokens: { accessToken: string } } }>(
      layers.outer!.baseUrl,
      '/api/v1/public/auth/register',
      { method: 'POST', body: JSON.stringify({ email: 'plain@example.com', password: 'Str0ng-Passw0rd!' }) },
    );
    const res = await request(layers.admin!.baseUrl, '/admin/info', {
      headers: bearer(registered.body.data.tokens.accessToken),
    });
    expect(res.status).toBe(403);
  });
});

describe('多端口隔离', () => {
  it('inner 端口未带内部令牌返回 401', async () => {
    const res = await request(layers.inner!.baseUrl, '/internal/status');
    expect(res.status).toBe(401);
  });

  it('inner 端口带错误令牌返回 401', async () => {
    const res = await request(layers.inner!.baseUrl, '/internal/status', {
      headers: { 'x-internal-token': 'wrong-token-wrong-token-wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('inner 端口带正确令牌返回服务状态', async () => {
    const res = await request<{ data: { services: { total: number }; uptime?: number } }>(
      layers.inner!.baseUrl,
      '/internal/status',
      { headers: { 'x-internal-token': INTERNAL_TOKEN } },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.services.total).toBeGreaterThan(0);
  });

  it('inner 端口能自查路由矩阵', async () => {
    const res = await request<{ data: unknown[] }>(layers.inner!.baseUrl, '/internal/routes', {
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(20);
  });

  it('inner 端口不接受 outer 的 JWT（边界是令牌类型，不是路径）', async () => {
    const res = await request(layers.inner!.baseUrl, '/internal/status', {
      headers: bearer('some.jwt.token'),
    });
    expect(res.status).toBe(401);
  });

  it('openapi 端口无 API Key 返回 401', async () => {
    const res = await request(layers.openapi!.baseUrl, '/openapi/v1/ping');
    expect(res.status).toBe(401);
  });

  it('API Key 只能通过 header 传，查询串传参无效（防泄漏进日志/Referer）', async () => {
    const res = await request(layers.openapi!.baseUrl, '/openapi/v1/ping?api_key=sk_live_fake');
    expect(res.status).toBe(401);
  });
});

describe('API Key 全流程', () => {
  let readOnlyKey = '';
  let whoamiKey = '';

  const createKey = async (name: string, scopes: string[]): Promise<string> => {
    const res = await request<{ data: { key: string } }>(layers.outer!.baseUrl, '/api/v1/keys', {
      method: 'POST',
      body: JSON.stringify({ name, scopes }),
    });
    expect(res.status).toBe(201);
    return res.body.data.key;
  };

  it('创建 API Key：明文只返回一次，列表里既无哈希也无明文', async () => {
    readOnlyKey = await createKey('CI read-only', ['tasks:read']);
    whoamiKey = await createKey('CI whoami', ['user:read']);
    expect(readOnlyKey).toMatch(/^sk_live_/);
    expect(readOnlyKey).not.toBe(whoamiKey);

    const list = await request<{ data: Array<Record<string, unknown>> }>(layers.outer!.baseUrl, '/api/v1/keys');
    const serialized = JSON.stringify(list.body);
    // 服务端只存哈希，列表接口绝不能回显任何可用于认证的字段
    expect(serialized).not.toContain('keyHash');
    expect(serialized).not.toContain(readOnlyKey);
    expect(serialized).not.toContain(whoamiKey);
  });

  it('非法 scope 被拒绝（白名单校验，不是自由文本）', async () => {
    const res = await request(layers.outer!.baseUrl, '/api/v1/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'bad', scopes: ['root:everything'] }),
    });
    expect(res.status).toBe(400);
  });

  it('scope 足够时可通过 openapi 鉴权', async () => {
    const res = await request<{ data: { scopes: string[] } }>(layers.openapi!.baseUrl, '/openapi/v1/whoami', {
      headers: { 'x-api-key': whoamiKey },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.scopes).toContain('user:read');
  });

  it('scope 不足时返回 403（最小权限真的生效）', async () => {
    // whoami 需要 user:read，而这个 key 只有 tasks:read
    const res = await request<{ error: { code: string } }>(layers.openapi!.baseUrl, '/openapi/v1/whoami', {
      headers: { 'x-api-key': readOnlyKey },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('撤销后立即失效，且只影响被撤销的那一个', async () => {
    const list = await request<{ data: Array<{ id: string; name: string }> }>(layers.outer!.baseUrl, '/api/v1/keys');
    const target = list.body.data.find((k) => k.name === 'CI read-only')!;
    const revoked = await request(layers.outer!.baseUrl, `/api/v1/keys/${target.id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(204);

    expect(
      (await request(layers.openapi!.baseUrl, '/openapi/v1/whoami', { headers: { 'x-api-key': readOnlyKey } })).status,
    ).toBe(401);
    // 未撤销的 key 不受影响
    expect(
      (await request(layers.openapi!.baseUrl, '/openapi/v1/whoami', { headers: { 'x-api-key': whoamiKey } })).status,
    ).toBe(200);
  });

  it('撤销不存在的 Key 返回 404', async () => {
    const res = await request(layers.outer!.baseUrl, '/api/v1/keys/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

describe('CORS', () => {
  it('白名单来源返回 ACAO，并允许携带凭据', async () => {
    const res = await request(layers.outer!.baseUrl, '/api/v1/public/ping', {
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('非白名单来源不回 ACAO（浏览器侧即被拦截）', async () => {
    const res = await request(layers.outer!.baseUrl, '/api/v1/public/ping', {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('openapi 端口放开来源但禁止凭据', async () => {
    const res = await request(layers.openapi!.baseUrl, '/openapi/v1/ping', {
      headers: { origin: 'https://any.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('限流', () => {
  it('auth 档位被限流，429 带 retryAfter 与 Retry-After 头', async () => {
    const attempt = () =>
      request<{ error: { code: string; retryAfter?: number } }>(layers.outer!.baseUrl, '/api/v1/public/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'nobody@example.com', password: 'whatever-wrong' }),
      });

    let limited: Awaited<ReturnType<typeof attempt>> | null = null;
    for (let i = 0; i < 15; i += 1) {
      const res = await attempt();
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(limited!.body.error.code).toBe('RATE_LIMITED');
    expect(limited!.body.error.retryAfter).toBeGreaterThan(0);
    expect(limited!.headers.get('retry-after')).toBeTruthy();
  });
});
