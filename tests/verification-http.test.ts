/**
 * 验证码接口的端到端 HTTP 测试。
 *
 * 单测已经覆盖了服务内部逻辑，这里补的是「跨路由层才成立」的三件事：
 *   - 路由真的挂在 outer 端口的 /public 下，且匿名可达
 *   - 响应体里**没有**验证码本身，只有打码 target
 *   - 冷却期返回 429（限流中间件与服务自身限频叠加生效）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, type Config } from '../src/config/schema.js';
import { wire, type WiredApplication } from '../src/serve/wire.js';
import { createMemorySender } from '../src/modules/verification/verification.sender.js';
import { StubCache, StubDatabase, StubQueue, StubState } from './helpers/stub-infra.js';
import { request, startLayers, type RunningChannel } from './helpers/http-harness.js';

let wired: WiredApplication;
let layers: Record<string, RunningChannel>;
const sender = createMemorySender();

function testConfig(): Config {
  const config = defaultConfig();
  config.environment = 'test';
  config.app.name = 'ts-server-starter-verification-test';
  config.logging.level = 'silent';
  config.server.port = 0;
  config.server.adminPort = 0;
  config.server.internalPort = 0;
  config.server.openapiPort = 0;
  config.server.metricsPort = 0;
  config.cache.driver = 'memory';
  config.mq.driver = 'memory';
  config.state.driver = 'memory';
  config.security.sessionSecret = 'test-session-secret-at-least-32-chars-long';
  config.database.driver = 'postgres';
  config.verification.cooldownMs = 60_000;
  return config;
}

beforeAll(async () => {
  wired = await wire({
    config: testConfig(),
    verificationSender: sender,
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
});

interface SendBody {
  success: boolean;
  data?: { target: string; expiresInMs: number };
  error?: { code: string };
}
interface VerifyBody {
  success: boolean;
  data?: { ok: boolean; reason?: string; remainingAttempts?: number };
}

describe('验证码接口', () => {
  it('匿名可发送，响应只含打码 target，不含验证码', async () => {
    const res = await request<SendBody>(layers.outer!.baseUrl, '/api/v1/public/verification/codes', {
      method: 'POST',
      body: JSON.stringify({ target: 'send@example.com', purpose: 'login' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.target).toBe('s***@example.com');
    expect(res.body.data?.expiresInMs).toBeGreaterThan(0);

    const issued = sender.sent.at(-1);
    expect(issued?.purpose).toBe('login');
    // 响应文本里绝不能出现真实验证码
    expect(JSON.stringify(res.body)).not.toContain(issued?.code ?? '###');
  });

  it('冷却期内再次发送返回 429', async () => {
    const body = JSON.stringify({ target: 'cooldown@example.com', purpose: 'login' });
    const first = await request<SendBody>(layers.outer!.baseUrl, '/api/v1/public/verification/codes', {
      method: 'POST',
      body,
    });
    expect(first.status).toBe(200);

    const second = await request<SendBody>(layers.outer!.baseUrl, '/api/v1/public/verification/codes', {
      method: 'POST',
      body,
    });
    expect(second.status).toBe(429);
    expect(second.body.error?.code).toBe('RATE_LIMITED');
  });

  it('正确验证码校验通过', async () => {
    const send = await request<SendBody>(layers.outer!.baseUrl, '/api/v1/public/verification/codes', {
      method: 'POST',
      body: JSON.stringify({ target: 'ok@example.com', purpose: 'login' }),
    });
    expect(send.status).toBe(200);
    const code = sender.sent.at(-1)?.code ?? '';

    const res = await request<VerifyBody>(layers.outer!.baseUrl, '/api/v1/public/verification/verify', {
      method: 'POST',
      body: JSON.stringify({ target: 'ok@example.com', purpose: 'login', code }),
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });
  });

  it('错误验证码返回结构化失败与剩余次数', async () => {
    const send = await request<SendBody>(layers.outer!.baseUrl, '/api/v1/public/verification/codes', {
      method: 'POST',
      body: JSON.stringify({ target: 'wrong@example.com', purpose: 'register' }),
    });
    expect(send.status).toBe(200);

    const res = await request<VerifyBody>(layers.outer!.baseUrl, '/api/v1/public/verification/verify', {
      method: 'POST',
      body: JSON.stringify({ target: 'wrong@example.com', purpose: 'register', code: '000000' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.data?.ok).toBe(false);
    expect(res.body.data?.reason).toBe('mismatch');
    expect(res.body.data?.remainingAttempts).toBeGreaterThan(0);
  });

  it('非法入参返回 400 VALIDATION_ERROR', async () => {
    const res = await request<SendBody>(layers.outer!.baseUrl, '/api/v1/public/verification/codes', {
      method: 'POST',
      body: JSON.stringify({ target: 'not-a-target', purpose: 'login' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });
});
