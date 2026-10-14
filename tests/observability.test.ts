/**
 * 日志与脱敏。
 *
 * 这两块不写测试的代价特别高：它们平时无声无息，
 * 出事时才发现「日志里全是 [object Object]」或「密码被写进了审计表」。
 */
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLogger, serializeError } from '../src/shared/logger.js';
import { createRedactor, redactHeaders, REDACTED } from '../src/security/redact.js';
import { RouteRegistry } from '../src/app/routes/registry.js';

/** 等文件里出现 n 行（轮询而不是 sleep：写流完成时间不确定） */
async function waitForFileLines(filePath: string, count: number, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let content = '';
  for (;;) {
    try {
      content = readFileSync(filePath, 'utf8');
      if (content.split('\n').filter(Boolean).length >= count) return content;
    } catch {
      // 文件还没被创建（createWriteStream 的 open 是异步的）
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} lines in ${filePath}: ${content}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function captureLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    format: 'json',
    // 自定义 sink：避免测试往 stdout 刷日志，也便于抓取原始行
    sink: (line) => lines.push(line),
  });
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('StructuredLogger', () => {
  it('按级别过滤：debug 开关生效', () => {
    const { logger, lines } = captureLogger('warn');
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    logger.error('yes');
    expect(lines).toHaveLength(2);
  });

  it('输出合法 JSON，含 level/time/msg 与自定义字段', () => {
    const { logger, parsed } = captureLogger();
    logger.info('request handled', { status: 200, path: '/api/v1/ping' });
    const entry = parsed()[0]!;
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('request handled');
    expect(entry.status).toBe(200);
    expect(typeof entry.time).toBe('string');
  });

  it('child() 合并基础字段，且不重开文件句柄', () => {
    const { logger, parsed } = captureLogger();
    const child = logger.child({ requestId: 'r-1' }).component('auth');
    child.info('signin');
    expect(parsed()[0]).toMatchObject({ requestId: 'r-1', component: 'auth' });
  });

  it('error(err, msg) 把异常序列化成可检索字段', () => {
    const { logger, parsed } = captureLogger();
    const cause = new Error('root cause');
    const error = new Error('outer', { cause });
    error.name = 'PaymentError';
    logger.error(error, 'charge failed', { orderId: 'o-1' });
    const entry = parsed()[0]!;
    expect(entry.msg).toBe('charge failed');
    expect(entry.orderId).toBe('o-1');
    // 错误对象必须被展开，否则日志里只剩 "[object Object]"
    const serialized = entry.err as Record<string, unknown>;
    expect(serialized.name).toBe('PaymentError');
    expect(serialized.message).toBe('outer');
    expect(String(serialized.stack)).toContain('Error: outer');
    expect((serialized.cause as Record<string, unknown>).message).toBe('root cause');
  });

  it('serializeError 处理非 Error 值不抛异常', () => {
    expect(serializeError('plain string')).toMatchObject({ message: 'plain string' });
    expect(serializeError({ code: 'E_X' })).toBeTruthy();
    expect(serializeError(null)).toBeTruthy();
  });

  it('循环引用的字段不会导致日志抛错', () => {
    const { logger, parsed } = captureLogger();
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => logger.info('circular', { circular })).not.toThrow();
    expect(parsed()[0]?.msg).toBe('circular');
  });

  it('child() 继承写出口：component logger 不会偷偷换回 stdout', () => {
    // 真事：child() 只用 Object.assign 复制了 writer/sink，漏了 output，
    // 于是 `logging.output: stderr`（CLI 让 stdout 留给数据）在 component 日志上失效 ——
    // `routes > ROUTERS.md` 就把启动期的日志行写进了产物文件。
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logger = createLogger({ level: 'debug', format: 'text', output: 'stderr' });

    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string) => {
      stdout.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk: string) => {
      stderr.push(String(chunk));
      return true;
    };
    try {
      logger.component('state').debug('disabled');
      logger.info('plain');
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }

    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('disabled');
    expect(stderr.join('')).toContain('plain');
  });

  it('output: file 时 component logger 共享同一个 writer（不各写各的文件）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'logger-file-'));
    try {
      const filePath = path.join(dir, 'app.log');
      const logger = createLogger({ level: 'debug', format: 'text', output: 'file', filePath });
      // 记录建了几个写流：父子共享同一个 writer 时只有 1 个。
      // 若 child 自己 new 一个 writer，两个 writer 各记各的字节数，
      // 轮转时就会互相截断（同一路径被 rename 两次）。
      const createStream = vi.spyOn(fs, 'createWriteStream');
      try {
        logger.component('serve').info('started');
        logger.info('stopped');
        await new Promise((resolve) => setImmediate(resolve));
        expect(createStream).toHaveBeenCalledTimes(1);
      } finally {
        createStream.mockRestore();
      }

      // 写流是异步的，等文件里出现第二行（不 sleep）
      const content = await waitForFileLines(filePath, 2);
      expect(content).toContain('started');
      expect(content).toContain('stopped');
      expect(readdirSync(dir)).toEqual(['app.log']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('text 格式输出人类可读单行，同时保留字段', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', format: 'text', sink: (line) => lines.push(line) });
    logger.info('hello', { a: 1 });
    expect(lines[0]).toContain('hello');
    expect(lines[0]).toContain('a=1');
  });
});

describe('Redactor', () => {
  const redactor = createRedactor({
    keys: ['password', 'token', 'secret', 'authorization', 'cookie', 'apikey'],
  });

  it('完全匹配的敏感键被打码', () => {
    expect(redactor({ password: 'hunter2', name: 'ok' })).toEqual({ password: REDACTED, name: 'ok' });
  });

  it('识别变体：大小写、连字符、下划线、前缀后缀', () => {
    const result = redactor({
      'X-Api-Key': 'sk_live_x',
      user_password: 'p',
      Authorization: 'Bearer x',
      refreshToken: 'r',
    }) as Record<string, unknown>;
    expect(result['X-Api-Key']).toBe(REDACTED);
    expect(result.user_password).toBe(REDACTED);
    expect(result.Authorization).toBe(REDACTED);
    // 以 token 结尾的键同样命中
    expect(result.refreshToken).toBe(REDACTED);
  });

  it('递归处理嵌套对象与数组', () => {
    const result = redactor({
      user: { name: 'a', credentials: { password: 'x' } },
      items: [{ token: 'y' }, { ok: 1 }],
    });
    expect(JSON.stringify(result)).not.toContain('"x"');
    expect(JSON.stringify(result)).not.toContain('"y"');
    expect(JSON.stringify(result)).toContain('"ok":1');
  });

  it('深度上限生效，避免深层结构拖慢日志路径', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'bottom' } } } } } } };
    expect(JSON.stringify(redactor(deep))).toContain('MAX_DEPTH');
  });

  it('循环引用标记为 [CIRCULAR] 而不是爆栈', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    expect(JSON.stringify(redactor(circular))).toContain('CIRCULAR');
  });

  it('Error 被降级成 name/message，不泄漏自定义字段', () => {
    const error = Object.assign(new Error('boom'), { password: 'leaked' });
    const result = redactor({ error }) as { error: Record<string, unknown> };
    expect(result.error).toEqual({ name: 'Error', message: 'boom' });
  });

  it('redactHeaders 只保留白名单头，Cookie/Authorization 直接消失', () => {
    const headers = redactHeaders({
      'user-agent': 'curl/8',
      authorization: 'Bearer secret',
      cookie: 'session=abc',
      'x-request-id': 'r-1',
    });
    expect(headers['user-agent']).toBe('curl/8');
    expect(headers['x-request-id']).toBe('r-1');
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });
});

describe('RouteRegistry', () => {
  it('按层过滤并按路径排序，输出稳定的 Markdown', () => {
    const registry = new RouteRegistry();
    registry.add({
      method: 'GET',
      path: '/api/v1/b',
      layer: 'outer',
      access: 'public',
      rateLimit: 'global',
      description: 'B',
      hasValidation: false,
    });
    registry.add({
      method: 'POST',
      path: '/api/v1/a',
      layer: 'outer',
      access: 'user',
      rateLimit: 'strict:write',
      description: 'A',
      hasValidation: true,
    });
    registry.add({
      method: 'GET',
      path: '/internal/x',
      layer: 'inner',
      access: 'internal',
      rateLimit: 'global',
      description: '',
      hasValidation: false,
    });

    expect(registry.list('outer')).toHaveLength(2);
    expect(registry.list('inner')).toHaveLength(1);

    const markdown = registry.toMarkdown();
    expect(markdown).toContain('## outer');
    expect(markdown).toContain('## inner');
    expect(markdown).toContain('/api/v1/a');
    // 表格行顺序稳定，diff 才有意义
    expect(markdown.indexOf('/api/v1/a')).toBeLessThan(markdown.indexOf('/api/v1/b'));
  });

  it('未注册时输出可读说明，而不是空字符串', () => {
    expect(new RouteRegistry().toMarkdown()).toContain('Route Matrix');
  });

  it('导出的是纯数据，供 /internal/routes 直接返回', () => {
    const registry = new RouteRegistry();
    registry.add({
      method: 'GET',
      path: '/x',
      layer: 'outer',
      access: 'public',
      rateLimit: 'global',
      description: '',
      hasValidation: false,
    });
    const [record] = registry.list();
    expect(record).toMatchObject({ method: 'GET', path: '/x', layer: 'outer', access: 'public' });
  });
});

describe('ServiceManager 的失败处理', () => {
  it('启动失败时回滚已启动的服务，不留半启动状态', async () => {
    const { ServiceManager } = await import('../src/core/service-manager.js');
    const { FunctionalService } = await import('../src/core/service.js');
    const { createServiceContext } = await import('../src/core/context.js');
    const logger = createLogger({ level: 'silent', sink: () => undefined });

    const stopped: string[] = [];
    const manager = new ServiceManager({ logger });
    manager.register(
      new FunctionalService(
        'first',
        async () => undefined,
        async () => {
          stopped.push('first');
        },
      ),
    );
    manager.register(
      new FunctionalService('second', async () => {
        throw new Error('boom during start');
      }),
    );
    manager.register(
      new FunctionalService('third', async () => {
        throw new Error('should never start');
      }),
    );

    const { ctx, dispose } = createServiceContext({ logger });
    await expect(manager.startAll(ctx)).rejects.toThrow(/boom during start/);
    dispose();

    // 已经起来的必须被回滚
    expect(stopped).toEqual(['first']);
    expect(manager.getService('first')?.isRunning).toBe(false);
    // 失败的服务记录了自己的错误，便于 /internal/status 暴露
    expect(manager.getService('second')?.lastError).toBeInstanceOf(Error);
    // 后续服务不该被启动
    expect(manager.getService('third')?.lastError).toBeNull();
  });

  it('getStatus() 暴露每个服务的运行状态', async () => {
    const { ServiceManager } = await import('../src/core/service-manager.js');
    const { FunctionalService } = await import('../src/core/service.js');
    const { createServiceContext } = await import('../src/core/context.js');
    const logger = createLogger({ level: 'silent', sink: () => undefined });
    const manager = new ServiceManager({ logger });
    manager.register(new FunctionalService('ok', async () => undefined));
    const { ctx, dispose } = createServiceContext({ logger });
    await manager.startAll(ctx);
    const status = manager.getStatus();
    expect(status).toEqual([expect.objectContaining({ name: 'ok', running: true })]);
    await manager.stopAll(ctx);
    expect(manager.getStatus()[0]).toMatchObject({ running: false });
    dispose();
  });
});

describe('Redactor 与日志集成', () => {
  it('脱敏后的对象可以直接写日志，且不含敏感值', () => {
    const spy = vi.fn();
    const logger = createLogger({ level: 'debug', format: 'json', sink: spy });
    const redactor = createRedactor({ keys: ['password'] });
    logger.info('login', { payload: redactor({ email: 'a@b.c', password: 'leaked' }) });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).not.toContain('leaked');
    expect(line).toContain('a@b.c');
  });
});
