/**
 * 结构化日志（zerolog 等价实现，零依赖）
 *
 *   logger.info('server listening', { port: 4600 })
 *   logger.error(err, 'generation failed', { taskId })
 *   const log = logger.component('http-outer')
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;

const WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
  silent: 99,
};

export interface LoggerOptions {
  level?: LogLevel | (string & {});
  format?: 'json' | 'text';
  /**
   * `stderr` 的用途：stdout 要留给**数据**时（CLI 一次性命令，如 `routes > ROUTERS.md`），
   * 日志必须走 stderr，否则日志行会被重定向进产物文件里。
   */
  output?: 'stdout' | 'stderr' | 'file';
  /**
   * 自定义落地点，优先级高于 output。
   * 存在的意义：测试可以抓取日志断言（而不必 mock process.stdout），
   * 嵌入方也可以把日志转发到自己的通道。
   */
  sink?: (line: string) => void;
  filePath?: string;
  maxSize?: number;
  maxBackups?: number;
  maxAge?: number;
  compress?: boolean;
  base?: LogFields;
}

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  error(err: unknown, msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  fatal(err: unknown, msg: string, fields?: LogFields): void;
  component(name: string): Logger;
  child(fields: LogFields): Logger;
}

/**
 * 安全的 JSON 序列化。
 *
 * 日志代码抛异常是最糟的失败模式：它会把「记录问题的路径」变成「产生问题的路径」。
 * 所以这里必须兜住两类必然出现的输入：
 *   - 循环引用（对象图里有回指）
 *   - 无法序列化的值（BigInt、函数、Symbol）
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    // replacer 的参数是 any，显式标注 unknown 以免把 any 泄漏给调用方
    return JSON.stringify(value, (_key, val: unknown): unknown => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[CIRCULAR]';
        seen.add(val);
      }
      return val;
    });
  } catch (err) {
    return JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      msg: 'log serialization failed',
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 把异常序列化成可检索的日志字段。
 *
 * 两个容易踩的点：
 *  1. cause 必须递归展开 —— 只写 String(cause) 的话，被包装的原始错误
 *     （往往才是真正的原因）会变成 "[object Object]"，等于没记
 *  2. 允许自定义字段（statusCode、retryable 等）出现在日志里，
 *     否则排查时只能靠 message 猜
 */
export function serializeError(err: unknown, depth = 0): LogFields {
  const MAX_CAUSE_DEPTH = 5;
  if (err instanceof Error) {
    const out: LogFields = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack.split('\n').slice(0, 6).join('\n');

    const extra = err as Error & { code?: unknown; statusCode?: unknown; cause?: unknown };
    if (extra.code !== undefined) out.code = extra.code;
    if (extra.statusCode !== undefined) out.statusCode = extra.statusCode;
    if (extra.cause !== undefined) {
      out.cause =
        depth >= MAX_CAUSE_DEPTH
          ? '[MAX_CAUSE_DEPTH]'
          : extra.cause instanceof Error
            ? serializeError(extra.cause, depth + 1)
            : // 非 Error 的 cause 也不能直接 String()，
              // 否则对象会变成 "[object Object]"，等于把原因丢了
              { message: typeof extra.cause === 'string' ? extra.cause : safeStringify(extra.cause) };
    }
    return out;
  }
  if (typeof err === 'string') return { message: err };
  // 非 Error 的抛出物（很少见，但 JS 允许）用安全序列化兜住，避免丢信息
  return { message: safeStringify(err) };
}

function normalizeArgs(a: unknown, b?: unknown, c?: LogFields) {
  if (typeof a === 'string') return { msg: a, fields: (b as LogFields | undefined) ?? c };
  return { err: a, msg: typeof b === 'string' ? b : '', fields: c };
}

class RotatingFileWriter {
  private readonly basePath: string;
  private readonly maxBytes: number;
  private readonly maxBackups: number;
  private readonly maxAgeMs: number;
  private readonly compress: boolean;
  private stream: fs.WriteStream | null = null;
  private written = 0;

  constructor(filePath: string, o: { maxSize: number; maxBackups: number; maxAge: number; compress: boolean }) {
    this.basePath = filePath;
    this.maxBytes = Math.max(1, o.maxSize) * 1024 * 1024;
    this.maxBackups = Math.max(0, o.maxBackups);
    this.maxAgeMs = Math.max(0, o.maxAge) * 86_400_000;
    this.compress = o.compress;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  write(line: string): void {
    this.ensureStream();
    const size = Buffer.byteLength(line);
    if (this.written + size > this.maxBytes) this.rotate();
    this.stream?.write(line);
    this.written += size;
  }

  private ensureStream(): void {
    if (this.stream) return;
    try {
      this.written = fs.existsSync(this.basePath) ? fs.statSync(this.basePath).size : 0;
      this.stream = fs.createWriteStream(this.basePath, { flags: 'a' });
      this.stream.on('error', (err) => {
        process.stderr.write(`[logger] file write failed: ${err.message}\n`);
        this.stream = null;
      });
    } catch (err) {
      process.stderr.write(`[logger] cannot open log file: ${(err as Error).message}\n`);
      this.stream = null;
    }
  }

  private rotate(): void {
    this.stream?.end();
    this.stream = null;
    this.prune();
    try {
      if (fs.existsSync(this.basePath)) {
        const rotated = `${this.basePath}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.renameSync(this.basePath, rotated);
        if (this.compress) {
          fs.createReadStream(rotated)
            .pipe(zlib.createGzip())
            .pipe(fs.createWriteStream(`${rotated}.gz`))
            .on('finish', () => fs.unlink(rotated, () => {}));
        }
      }
    } catch (err) {
      process.stderr.write(`[logger] rotation failed: ${(err as Error).message}\n`);
    }
    this.written = 0;
  }

  private prune(): void {
    const dir = path.dirname(this.basePath);
    const prefix = `${path.basename(this.basePath)}.`;
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
    } catch {
      return;
    }
    const now = Date.now();
    names
      .map((f) => {
        const full = path.join(dir, f);
        try {
          return { full, mtime: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((s): s is { full: string; mtime: number } => s !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .forEach((file, index) => {
        if (index >= this.maxBackups || (this.maxAgeMs > 0 && now - file.mtime > this.maxAgeMs)) {
          fs.unlink(file.full, () => {});
        }
      });
  }
}

class StructuredLogger implements Logger {
  readonly level: LogLevel;
  private readonly format: 'json' | 'text';
  /** 实际写出口（`file` 由 writer 承担，这里就退化成 stdout 供 child 判断） */
  private readonly configuredOutput: 'stdout' | 'stderr' | 'file';
  private readonly output: 'stdout' | 'stderr';
  private readonly writer: RotatingFileWriter | null;
  private readonly base: LogFields;
  private readonly sink: ((line: string) => void) | null;
  private readonly opts: LoggerOptions;

  constructor(opts: LoggerOptions = {}) {
    this.opts = opts;
    this.configuredOutput = opts.output ?? 'stdout';
    this.output = opts.output === 'stderr' ? 'stderr' : 'stdout';
    this.level = (LOG_LEVELS as readonly string[]).includes(String(opts.level)) ? (opts.level as LogLevel) : 'info';
    this.format = opts.format === 'text' ? 'text' : 'json';
    this.base = { ...(opts.base ?? {}) };
    this.sink = opts.sink ?? null;
    this.writer =
      opts.output === 'file'
        ? new RotatingFileWriter(opts.filePath || './logs/app.log', {
            maxSize: opts.maxSize ?? 100,
            maxBackups: opts.maxBackups ?? 3,
            maxAge: opts.maxAge ?? 7,
            compress: opts.compress ?? true,
          })
        : null;
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields);
  }

  error(a: unknown, b?: unknown, c?: LogFields): void {
    const { err, msg, fields } = normalizeArgs(a, b, c);
    this.emit('error', msg, err === undefined ? fields : { ...fields, err: serializeError(err) });
  }

  fatal(a: unknown, b?: unknown, c?: LogFields): void {
    const { err, msg, fields } = normalizeArgs(a, b, c);
    this.emit('fatal', msg, err === undefined ? fields : { ...fields, err: serializeError(err) });
  }

  component(name: string): Logger {
    return this.child({ component: name });
  }

  child(fields: LogFields): Logger {
    // output / sink 必须继承：`logger.component('x')` 出来的日志曾经会悄悄换回 stdout
    // （表现是 `routes > ROUTERS.md` 把启动期的日志行也写进了产物文件）。
    const derived = new StructuredLogger({
      ...this.opts,
      // 文件场景不在这里再建 writer：两个 writer 各自轮转同一个文件会互相踩，
      // 所以下面直接共享实例。
      output: this.configuredOutput === 'file' ? 'stdout' : this.output,
      base: { ...this.base, ...fields },
    });
    Object.assign(derived, { writer: this.writer });
    return derived;
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (WEIGHT[level] < WEIGHT[this.level]) return;
    const record: LogFields = { level, time: new Date().toISOString(), ...this.base, msg, ...fields };
    const line = this.format === 'json' ? `${safeStringify(record)}\n` : this.toText(record);

    // 自定义 sink 优先：测试与嵌入场景不应该被强制写 stdout
    if (this.sink) {
      this.sink(line);
      return;
    }
    if (this.writer) {
      this.writer.write(line);
      if (WEIGHT[level] >= WEIGHT.warn) process.stderr.write(line);
    } else if (this.output === 'stderr' || WEIGHT[level] >= WEIGHT.warn) {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  private toText(record: LogFields): string {
    const { level, time, msg, component, err, ...rest } = record as LogFields & {
      level: string;
      time: string;
      msg: string;
      component?: string;
      err?: LogFields;
    };
    const extras = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    return (
      [
        time,
        level.toUpperCase().padEnd(5),
        component ? `[${component}]` : '',
        msg,
        extras,
        err ? `err=${typeof err.message === 'string' ? err.message : safeStringify(err.message)}` : '',
      ]
        .filter(Boolean)
        .join(' ') + '\n'
    );
  }
}

let globalLogger: Logger | null = null;

export function initGlobalLogger(opts: LoggerOptions): Logger {
  globalLogger ??= new StructuredLogger(opts);
  return globalLogger;
}

export function getLogger(): Logger {
  return (globalLogger ??= new StructuredLogger({ level: 'info', format: 'text', output: 'stdout' }));
}

export function resetGlobalLogger(): void {
  globalLogger = null;
}
export function createLogger(opts: LoggerOptions): Logger {
  return new StructuredLogger(opts);
}
