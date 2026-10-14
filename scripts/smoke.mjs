#!/usr/bin/env node
/**
 * 端到端冒烟测试（零依赖，只用 node 内置模块）。
 *
 * 用法：
 *   1. 另开一个终端跑 `pnpm dev`
 *   2. `node scripts/smoke.mjs`
 *
 * 端口从环境变量读，默认对应 .env.example：
 *   SMOKE_OUTER=4600 SMOKE_ADMIN=4601 SMOKE_INNER=4602 SMOKE_OPENAPI=4603 SMOKE_METRICS=4604
 *   SMOKE_INTERNAL_TOKEN=<与 SECURITY__INTERNAL_TOKEN 相同>
 *
 * 它覆盖的是**跨层行为**，这些恰恰是单元测试看不到的：
 * 多端口隔离、CORS 差异、限流分层、API Key 作用域、审计脱敏、
 * 优雅关闭前的错误码形状。
 */
import { readFileSync } from 'node:fs';

const OUTER = `http://127.0.0.1:${process.env.SMOKE_OUTER ?? '4600'}`;
const ADMIN = `http://127.0.0.1:${process.env.SMOKE_ADMIN ?? '4601'}`;
const INNER = `http://127.0.0.1:${process.env.SMOKE_INNER ?? '4602'}`;
const OPENAPI = `http://127.0.0.1:${process.env.SMOKE_OPENAPI ?? '4603'}`;
const METRICS = `http://127.0.0.1:${process.env.SMOKE_METRICS ?? '4604'}`;

function internalToken() {
  if (process.env.SMOKE_INTERNAL_TOKEN) return process.env.SMOKE_INTERNAL_TOKEN;
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    return /^SECURITY__INTERNAL_TOKEN=(.*)$/m.exec(env)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

const INTERNAL_TOKEN = internalToken();

async function call(method, url, { body, headers = {}, raw = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    init.headers['Content-Type'] = init.headers['Content-Type'] ?? 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON（metrics / 204）保持原样 */
  }
  return { status: res.status, headers: Object.fromEntries(res.headers), body: parsed };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 限流是跨进程保留的（内存 store 按 IP 计数），所以上一次运行消耗掉的
 * auth 配额会让这一次的注册直接 429。与其让使用者困惑，
 * 不如按 Retry-After 等一个窗口再重试 —— 并把等待原因打出来。
 */
async function withRateLimitRetry(label, fn) {
  const first = await fn();
  if (first.status !== 429) return first;
  const seconds = Number(first.headers['retry-after'] ?? first.body?.error?.retryAfter ?? 61);
  const waitMs = Math.min(Math.max(seconds, 1), 120) * 1000;
  process.stdout.write(`  … ${label} 命中限流，等待 ${waitMs / 1000}s 后重试\n`);
  await sleep(waitMs);
  return fn();
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) });
  const mark = condition ? '\u001b[32m PASS \u001b[0m' : '\u001b[31m FAIL \u001b[0m';
  process.stdout.write(`${mark} ${name}${condition ? '' : `   ${describe(detail)}`}\n`);
}
function describe(value) {
  try {
    return JSON.stringify(value)?.slice(0, 200) ?? String(value);
  } catch {
    return String(value);
  }
}
function section(title) {
  process.stdout.write(`\n── ${title} ──\n`);
}

const stamp = Date.now();
const email = `alice+${stamp}@example.com`;

// ── outer：公开接口、安全头、注册登录
section('outer / public');
{
  const { status, headers, body } = await call('GET', `${OUTER}/api/v1/public/ping`);
  check('ping 200', status === 200 && body.data.pong === true, { status, body });
  check('安全响应头', headers['x-content-type-options'] === 'nosniff' && 'content-security-policy' in headers, headers);
  check('不泄漏 X-Powered-By', !('x-powered-by' in headers), headers);
  check('返回 request id', 'x-request-id' in headers, Object.keys(headers));
}

const register = await withRateLimitRetry('注册', () =>
  call('POST', `${OUTER}/api/v1/public/auth/register`, {
    body: { email, password: 'Sup3r-Secret-Pass', displayName: 'Alice' },
  }),
);
check('注册 201 并签发令牌', register.status === 201 && register.body.data.tokens.accessToken, register);
const access = register.body.data.tokens.accessToken;

check(
  '重复邮箱 409',
  (await call('POST', `${OUTER}/api/v1/public/auth/register`, { body: { email, password: 'Sup3r-Secret-Pass' } }))
    .status === 409,
);

// ── outer：鉴权
section('outer / auth');
{
  const me = await call('GET', `${OUTER}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${access}` } });
  check('me 200', me.status === 200 && me.body.data.email === email, me);

  const bad = await call('GET', `${OUTER}/api/v1/auth/me`, { headers: { Authorization: 'Bearer tampered.value' } });
  check('篡改令牌 401', bad.status === 401 && bad.body.error.code === 'UNAUTHORIZED', bad);
}

// ── outer：API Key
section('outer / api keys');
const created = await call('POST', `${OUTER}/api/v1/keys`, {
  body: { name: 'ci', scopes: ['tasks:read', 'user:read'] },
  headers: { Authorization: `Bearer ${access}` },
});
check('创建 API Key 201 且返回明文', created.status === 201 && created.body.data.key.startsWith('sk_live_'), created);
const plainKey = created.body.data.key;
const keyId = created.body.data.apiKey.id;
check('列表视图不含哈希', !('keyHash' in created.body.data.apiKey), created.body.data.apiKey);

check(
  '未知 scope 被拒绝',
  [400, 401].includes(
    (
      await call('POST', `${OUTER}/api/v1/keys`, {
        body: { name: 'bad', scopes: ['nope:write'] },
        headers: { Authorization: `Bearer ${access}` },
      })
    ).status,
  ),
);

const narrow = await call('POST', `${OUTER}/api/v1/keys`, {
  body: { name: 'narrow', scopes: ['tasks:read'] },
  headers: { Authorization: `Bearer ${access}` },
});
const narrowKey = narrow.body.data.key;

// ── outer：业务模块（cache + mq + audit）
section('outer / tasks');
{
  const createdTask = await call('POST', `${OUTER}/api/v1/tasks`, {
    body: { title: 'write docs', priority: 2 },
    headers: { Authorization: `Bearer ${access}` },
  });
  check('创建任务 201', createdTask.status === 201 && createdTask.body.data.title === 'write docs', createdTask);
  const taskId = createdTask.body.data.id;

  check(
    '任务列表',
    (await call('GET', `${OUTER}/api/v1/tasks`, { headers: { Authorization: `Bearer ${access}` } })).status === 200,
  );
  check(
    '任务统计（缓存路径）',
    (await call('GET', `${OUTER}/api/v1/tasks/stats`, { headers: { Authorization: `Bearer ${access}` } })).status === 200,
  );
  check(
    '任务详情',
    (await call('GET', `${OUTER}/api/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${access}` } })).status ===
      200,
  );
}

// ── admin 端口
section('admin');
{
  const info = await call('GET', `${ADMIN}/admin/info`);
  check('admin/info 200（dev bypass 带 admin 角色）', info.status === 200 && info.body.data.config, info);
  check('admin/users 200', (await call('GET', `${ADMIN}/admin/users`)).status === 200);

  const bob = await withRateLimitRetry('注册 bob', () =>
    call('POST', `${OUTER}/api/v1/public/auth/register`, {
      body: { email: `bob+${stamp}@example.com`, password: 'Sup3r-Secret-Pass2' },
    }),
  );
  const bobToken = bob.body.data.tokens.accessToken;
  const forbidden = await call('GET', `${ADMIN}/admin/info`, { headers: { Authorization: `Bearer ${bobToken}` } });
  check('普通用户 403', forbidden.status === 403 && forbidden.body.error.code === 'FORBIDDEN', forbidden);
}

// ── inner 端口：共享密钥
section('inner');
{
  const denied = await call('GET', `${INNER}/internal/status`);
  check('缺少内部密钥被拒', [401, 503].includes(denied.status), denied);
  const allowed = await call('GET', `${INNER}/internal/status`, { headers: { 'X-Internal-Token': INTERNAL_TOKEN } });
  check('带内部密钥 200', allowed.status === 200 && allowed.body.data.services.running >= 1, allowed);
  const routes = await call('GET', `${INNER}/internal/routes`, { headers: { 'X-Internal-Token': INTERNAL_TOKEN } });
  check('路由矩阵可自查', routes.status === 200 && routes.body.data.length >= 30, routes.status);
}

// ── metrics 端口
section('metrics');
{
  const { status, body } = await call('GET', `${METRICS}/metrics`);
  check('指标暴露', status === 200 && String(body).includes('process_uptime_seconds'), status);
}

// ── openapi 端口：只认 API Key，且 CORS 不带凭据
section('openapi');
{
  check('无密钥 401', (await call('GET', `${OPENAPI}/openapi/v1/ping`)).status === 401);
  check('带密钥 200', (await call('GET', `${OPENAPI}/openapi/v1/ping`, { headers: { 'X-Api-Key': plainKey } })).status === 200);

  const whoami = await call('GET', `${OPENAPI}/openapi/v1/whoami`, { headers: { 'X-Api-Key': plainKey } });
  check('作用域满足时 200', whoami.status === 200 && whoami.body.data.scopes.includes('user:read'), whoami);

  const blocked = await call('GET', `${OPENAPI}/openapi/v1/whoami`, { headers: { 'X-Api-Key': narrowKey } });
  check('作用域不足 403', blocked.status === 403 && blocked.body.error.code === 'FORBIDDEN', blocked);

  const bearer = await call('GET', `${OPENAPI}/openapi/v1/whoami`, { headers: { Authorization: `Bearer ${access}` } });
  check('openapi 不接受 Bearer', bearer.status === 401, bearer);
}

// ── 错误处理
section('error handling');
{
  const malformed = await call('POST', `${OUTER}/api/v1/public/auth/login`, { body: '{"email": broken', raw: true });
  check('非法 JSON 400', malformed.status === 400 && malformed.body.error.code === 'VALIDATION_ERROR', malformed);
  const missing = await call('GET', `${OUTER}/api/v1/nope`);
  check('404 结构统一', missing.status === 404 && missing.body.error.code === 'NOT_FOUND', missing);
  check('错误响应带 requestId', Boolean(missing.body.error.requestId), missing.body.error);
}

// ── 限流分层
section('rate limit');
{
  const codes = [];
  for (let i = 0; i < 14; i += 1) {
    const res = await call('POST', `${OUTER}/api/v1/public/auth/login`, {
      body: { email: 'nobody@example.com', password: 'wrong-password-1234' },
    });
    codes.push(res.status);
    if (res.status === 429) {
      check('auth 限流返回 429 且结构统一', res.body.error.code === 'RATE_LIMITED', res.body);
      break;
    }
  }
  check('auth 档位触发 429', codes.includes(429), codes);
}

// ── CORS 分层差异
section('cors');
{
  const preflight = await call('OPTIONS', `${OUTER}/api/v1/public/ping`, {
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' },
  });
  check('白名单来源放行', preflight.headers['access-control-allow-origin'] === 'http://localhost:5173', preflight.headers);
  check('outer 允许携带凭据', preflight.headers['access-control-allow-credentials'] === 'true', preflight.headers);

  const evil = await call('GET', `${OUTER}/api/v1/public/ping`, { headers: { Origin: 'http://evil.example.com' } });
  check('非白名单来源无 ACAO', !('access-control-allow-origin' in evil.headers), evil.headers);

  const openapiPreflight = await call('OPTIONS', `${OPENAPI}/openapi/v1/ping`, {
    headers: { Origin: 'http://any.example.com', 'Access-Control-Request-Method': 'GET' },
  });
  check(
    'openapi 放开来源但禁止凭据',
    openapiPreflight.headers['access-control-allow-origin'] === '*' &&
      !('access-control-allow-credentials' in openapiPreflight.headers),
    openapiPreflight.headers,
  );
}

// ── 撤销
section('api key revoke');
{
  check('撤销前可用', (await call('GET', `${OPENAPI}/openapi/v1/ping`, { headers: { 'X-Api-Key': plainKey } })).status === 200);
  const revoked = await call('DELETE', `${OUTER}/api/v1/keys/${keyId}`, { headers: { Authorization: `Bearer ${access}` } });
  check('撤销返回 204', revoked.status === 204, revoked);
  check(
    '撤销后 401',
    (await call('GET', `${OPENAPI}/openapi/v1/ping`, { headers: { 'X-Api-Key': plainKey } })).status === 401,
  );
}

// ── 汇总
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.map((f) => f.name).join(', ')}\n`);
  process.exitCode = 1;
}
