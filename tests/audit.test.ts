/**
 * 安全审计。
 *
 * 这一块的价值全在「出事的时候查得到」，所以测的重点不是"函数返回了值"，
 * 而是几个容易悄悄失效的保证：
 *   - 失败/拒绝的事件真的被记下来了（撞库、越权、限流）
 *   - 数据库慢或挂了不会拖垮请求，也不会无限吃内存
 *   - 丢了多少条是可观测的，而不是静默消失
 *   - 没开落库时接口如实说"没开"，而不是返回空列表让人以为"没有安全事件"
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBufferedAuditSink, type AuditEventWriter } from '../src/security/audit-sink.js';
import { Auditor, AuditAction, type AuditEvent } from '../src/security/audit.js';
import { SqlAuditRepository } from '../src/modules/audit/audit.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { createLogger } from '../src/shared/logger.js';
import { runWithRequestContext } from '../src/shared/request-context.js';
import { defaultConfig, type Config } from '../src/config/schema.js';
import { wire, type WiredApplication } from '../src/serve/wire.js';
import { StubCache, StubDatabase, StubQueue, StubState } from './helpers/stub-infra.js';
import { request, startLayers, type RunningChannel } from './helpers/http-harness.js';

const silentLogger = createLogger({ level: 'silent', format: 'text', output: 'stdout' });

class RecordingWriter implements AuditEventWriter {
  readonly batches: AuditEvent[][] = [];
  fail = false;

  writeMany(events: readonly AuditEvent[]): Promise<void> {
    if (this.fail) return Promise.reject(new Error('database is down'));
    this.batches.push([...events]);
    return Promise.resolve();
  }

  get events(): AuditEvent[] {
    return this.batches.flat();
  }
}

function event(n: number): AuditEvent {
  return { action: 'test.action', outcome: 'success', resource: `r${n}` };
}

describe('Auditor.sinkNames', () => {
  it('如实反映已挂载的 sink —— 启动日志不能谎报审计去向', () => {
    const auditor = new Auditor([{ name: 'logger', write: () => undefined }]);
    expect(auditor.sinkNames).toEqual(['logger']);
    auditor.addSink({ name: 'database', write: () => undefined });
    expect(auditor.sinkNames).toEqual(['logger', 'database']);
  });
});

describe('审计 sink：缓冲与落库', () => {
  it('攒够 batchSize 立即冲刷，而不是干等定时器', async () => {
    const writer = new RecordingWriter();
    const sink = createBufferedAuditSink({ writer, logger: silentLogger, batchSize: 3, flushIntervalMs: 60_000 });
    for (let i = 0; i < 3; i += 1) void sink.write(event(i));
    await sink.flush();
    expect(writer.events.map((e) => e.resource)).toEqual(['r0', 'r1', 'r2']);
    await sink.close();
  });

  it('close() 会冲刷剩余事件 —— 优雅退出不能丢最后一批', async () => {
    const writer = new RecordingWriter();
    const sink = createBufferedAuditSink({ writer, logger: silentLogger, batchSize: 100, flushIntervalMs: 60_000 });
    void sink.write(event(1));
    void sink.write(event(2));
    expect(writer.events).toHaveLength(0);
    await sink.close();
    expect(writer.events).toHaveLength(2);
  });

  it('队列满了丢弃并计数，而不是无限占用内存', async () => {
    const writer = new RecordingWriter();
    writer.fail = true;
    const sink = createBufferedAuditSink({
      writer,
      logger: silentLogger,
      capacity: 5,
      batchSize: 1000,
      flushIntervalMs: 60_000,
    });
    for (let i = 0; i < 50; i += 1) void sink.write(event(i));

    expect(sink.stats().queued).toBe(5);
    expect(sink.stats().dropped).toBe(45);
    await sink.close();
  });

  it('写库失败只影响计数与日志，不向调用方抛异常', async () => {
    const writer = new RecordingWriter();
    writer.fail = true;
    const sink = createBufferedAuditSink({ writer, logger: silentLogger, batchSize: 2, flushIntervalMs: 60_000 });
    expect(() => {
      void sink.write(event(1));
      void sink.write(event(2));
    }).not.toThrow();
    await sink.flush();
    expect(sink.stats().failures).toBe(2);
    expect(sink.stats().lastError).toContain('database is down');
    await sink.close();
  });

  it('Auditor 会把上下文里的 userId / ip / userAgent / requestId 补进事件', () => {
    const writer = new RecordingWriter();
    const sink = createBufferedAuditSink({ writer, logger: silentLogger, batchSize: 1, flushIntervalMs: 60_000 });
    const auditor = new Auditor([sink]);
    const logger = silentLogger.child({ requestId: 'req-1' });

    runWithRequestContext({ requestId: 'req-1', userId: 'u-1', ip: '10.0.0.9', userAgent: 'probe/1.0', logger }, () => {
      auditor.record({ action: AuditAction.AuthFailed, outcome: 'failure' });
    });

    return sink.flush().then(() => {
      expect(writer.events[0]).toMatchObject({
        userId: 'u-1',
        ip: '10.0.0.9',
        userAgent: 'probe/1.0',
        requestId: 'req-1',
        outcome: 'failure',
      });
      return sink.close();
    });
  });

  it('sink 抛异常不会影响主流程（审计不能成为新的故障点）', () => {
    const logger = createLogger({ level: 'silent', format: 'text', output: 'stdout' });
    const auditor = new Auditor([
      {
        name: 'exploding',
        write() {
          throw new Error('sink exploded');
        },
      },
    ]);
    expect(() => auditor.record({ action: 'x', outcome: 'success' })).not.toThrow();
    expect(logger).toBeDefined();
  });
});

describe('审计仓储：SQL 方言与字段映射', () => {
  it('Postgres 下用 $n 占位符，并按行展开 VALUES', async () => {
    const database = new StubDatabase();
    const repository = new SqlAuditRepository(database);
    await repository.writeMany([event(1), event(2)]);

    expect(database.queries).toHaveLength(1);
    const { sql, params } = database.queries[0]!;
    // 2 行 × 8 列 = 16 个参数
    expect(params).toHaveLength(16);
    expect(sql).toContain('($1, $2, $3, $4, $5, $6, $7, $8), ($9, $10, $11, $12, $13, $14, $15, $16)');
    expect(sql).toContain('INSERT INTO audit_logs');
  });

  it('detail 序列化成 JSON 字符串，userId 原样保留（审计必须能记录非 UUID 主体）', async () => {
    const database = new StubDatabase();
    const repository = new SqlAuditRepository(database);
    await repository.writeMany([
      { action: 'a', outcome: 'success', userId: 'dev-user-0001', detail: { scopes: ['tasks:read'] } },
    ]);

    const { params } = database.queries[0]!;
    expect(params[2]).toBe('dev-user-0001');
    expect(JSON.parse(String(params[7]))).toEqual({ scopes: ['tasks:read'] });
  });

  it('写空批次不发 SQL（避免生成非法的 INSERT ... VALUES）', async () => {
    const database = new StubDatabase();
    await new SqlAuditRepository(database).writeMany([]);
    expect(database.queries).toHaveLength(0);
  });

  it('tail 的过滤条件与 limit 都用占位符，不拼接用户输入', async () => {
    const database = new StubDatabase();
    await new SqlAuditRepository(database).tail({ limit: 10, action: 'auth.failed', outcome: 'failure' });

    const { sql, params } = database.queries[0]!;
    expect(sql).toContain('action = $1');
    expect(sql).toContain('outcome = $2');
    expect(sql).toContain('LIMIT $3');
    expect(sql).not.toContain('auth.failed');
    expect(params).toEqual(['auth.failed', 'failure', 10]);
  });

  it('读回来的行会被归一化：字符串 detail 解析、时间转 ISO、缺字段补默认值', async () => {
    const database = new StubDatabase(() => ({
      rows: [
        {
          id: 7,
          action: 'auth.login',
          outcome: 'success',
          user_id: null,
          resource: null,
          ip: '127.0.0.1',
          user_agent: 'curl',
          request_id: 'r-1',
          detail: '{"a":1}',
          created_at: new Date('2026-01-02T03:04:05.000Z'),
        },
      ],
      rowCount: 1,
    }));
    const rows = await new SqlAuditRepository(database).tail({ limit: 1 });

    expect(rows[0]).toMatchObject({
      id: '7',
      userId: undefined,
      resource: '',
      detail: { a: 1 },
      createdAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('文档型数据库直接拒绝，而不是悄悄什么都不写', () => {
    const database = { driver: 'mongodb', dialect: 'document' } as unknown as StubDatabase;
    expect(() => new SqlAuditRepository(database)).toThrow(/requires a SQL database/);
  });
});

describe('审计服务：区分「没有数据」与「没开审计」', () => {
  it('未落库时 tail() 返回 null，接口据此如实报告', async () => {
    const service = new AuditService({ logger: silentLogger });
    expect(service.persisted).toBe(false);
    expect(await service.tail({ limit: 10 })).toBeNull();
    expect((await service.status()).sinks).toEqual(['logger']);
  });
});

describe('端到端：失败登录必须留下可检索的审计记录', () => {
  let wired: WiredApplication;
  let layers: Record<string, RunningChannel>;
  let database: StubDatabase;

  beforeAll(async () => {
    // admin 端口要 admin 角色；这里用开发旁路直接拿到身份
    process.env.DEV_AUTH_BYPASS = '1';
    process.env.DEV_USER_ID = 'dev-user-0001';
    process.env.DEV_USER_ROLES = 'user,admin';

    const config: Config = defaultConfig();
    config.environment = 'test';
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
    config.security.internalToken = 'internal-token-for-tests-0123456789';
    // 测试里不等 2s 的定时冲刷：攒 1 条就写
    config.security.auditBatchSize = 1;

    database = new StubDatabase();
    wired = await wire({
      config,
      infrastructure: {
        database,
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

  it('密码错误 → 401，且写入 audit_logs（含邮箱、原因、UA）', async () => {
    const res = await request(layers.outer!.baseUrl, '/api/v1/public/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'bruteforce-bot/1.0' },
      body: JSON.stringify({ email: 'victim@example.com', password: 'guessing-1' }),
    });
    expect(res.status).toBe(401);
    // 不能泄漏"账号不存在"这种枚举信息
    expect(JSON.stringify(res.body)).toContain('Invalid email or password');

    await wired.modules.audit.service.flush();

    const insert = database.queries.find((q) => q.sql.startsWith('INSERT INTO audit_logs'));
    expect(insert).toBeDefined();
    // 列顺序：action, outcome, user_id, resource, ip, user_agent, request_id, detail
    expect(insert!.params[0]).toBe('auth.failed');
    expect(insert!.params[1]).toBe('failure');
    expect(insert!.params[5]).toBe('bruteforce-bot/1.0');
    expect(JSON.parse(String(insert!.params[7]))).toEqual({
      reason: 'unknown account',
      email: 'victim@example.com',
    });
  });

  it('伪造 refresh token → 401，并记录签名校验失败的原因', async () => {
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciIsImF1ZCI6InJlZnJlc2gifQ.forged';
    const res = await request(layers.outer!.baseUrl, '/api/v1/public/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: forged }),
    });
    expect(res.status).toBe(401);
    await wired.modules.audit.service.flush();

    const inserts = database.queries.filter((q) => q.sql.startsWith('INSERT INTO audit_logs'));
    const detail = JSON.parse(String(inserts.at(-1)!.params[7]));
    expect(detail.reason).toBe('invalid refresh token');
    expect(String(detail.error)).toMatch(/signature/i);
  });

  it('admin 端点真的去查库了：过滤条件原样进 SQL 参数，而不是返回硬编码结果', async () => {
    const before = database.queries.length;
    const res = await request(layers.admin!.baseUrl, '/admin/audit/tail?action=auth.failed&limit=5');
    expect(res.status).toBe(200);

    const data = (res.body as { data: { persisted: boolean; items: unknown[] } }).data;
    expect(data.persisted).toBe(true);

    // 替身返回空结果集是刻意的：这里要证明的是"查询真的发出去了"，
    // 而不是"接口碰巧返回了 200"。items 的内容由真实数据库验证。
    // 除了检索本身，status() 还会发一条 COUNT(*)；两条都必须是真 SQL
    const issued = database.queries.slice(before).filter((q) => q.sql.includes('FROM audit_logs'));
    expect(issued).toHaveLength(2);
    const tailQuery = issued.find((q) => q.sql.includes('ORDER BY created_at DESC'));
    expect(tailQuery?.params).toEqual(['auth.failed', 5]);
    expect(issued.some((q) => q.sql.includes('COUNT(*)'))).toBe(true);
  });

  it('限流拒绝也会留下 denied 事件（撞库被发现靠的就是这个）', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    spy.mockRestore();
    const config = wired.config.security;
    const burst = Math.min(config.rateLimit.authMax + 2, 12);
    for (let i = 0; i < burst; i += 1) {
      await request(layers.outer!.baseUrl, '/api/v1/public/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `burst-${i}@example.com`, password: 'x-'.repeat(6) }),
      });
    }
    await wired.modules.audit.service.flush();

    const denied = database.queries
      .filter((q) => q.sql.startsWith('INSERT INTO audit_logs'))
      .filter((q) => q.params[0] === 'rate.limited');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]!.params[1]).toBe('denied');
  });
});
