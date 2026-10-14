/**
 * 进程生命周期。
 *
 * 三件事：
 *   1. 捕获未处理异常 —— Node 默认会直接退出，日志里什么都没有，
 *      排查成本极高；这里先落一条 fatal 再走优雅退出。
 *   2. 信号处理 —— SIGTERM/SIGINT 触发优雅退出，第二次信号强制退出。
 *   3. 退出超时 —— 优雅退出不能无限等，超时后 process.exit(1)。
 */
import type { Logger } from '../shared/logger.js';

export interface ShutdownHook {
  name: string;
  run(): Promise<void>;
}

export interface LifecycleOptions {
  logger: Logger;
  /** 整个退出流程的超时，默认 15s */
  shutdownTimeoutMs?: number;
  /** 监听哪些信号，默认 SIGINT + SIGTERM */
  signals?: NodeJS.Signals[];
  /** 强制退出码 */
  exitCode?: number;
}

export class Lifecycle {
  private readonly logger: Logger;
  private readonly hooks: ShutdownHook[] = [];
  private readonly timeoutMs: number;
  private readonly signals: NodeJS.Signals[];
  private readonly exitCode: number;
  private shuttingDown = false;
  private installed = false;
  private readonly controller = new AbortController();

  constructor(options: LifecycleOptions) {
    this.logger = options.logger.component('lifecycle');
    this.timeoutMs = options.shutdownTimeoutMs ?? 15_000;
    this.signals = options.signals ?? ['SIGINT', 'SIGTERM'];
    this.exitCode = options.exitCode ?? 0;
  }

  /** 供服务 start/stop 使用的取消信号 */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  onShutdown(name: string, run: () => Promise<void>): this {
    this.hooks.push({ name, run });
    return this;
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;

    for (const signal of this.signals) {
      process.on(signal, () => {
        if (this.shuttingDown) {
          this.logger.warn('second signal received, forcing exit', { signal });
          process.exit(1);
        }
        void this.shutdown(`signal:${signal}`);
      });
    }

    process.on('uncaughtException', (err) => {
      this.logger.fatal(err, 'uncaught exception');
      void this.shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      this.logger.fatal(reason, 'unhandled promise rejection');
      void this.shutdown('unhandledRejection');
    });

    process.on('warning', (warning) => {
      this.logger.warn('process warning', { name: warning.name, message: warning.message });
    });
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.logger.info('shutting down', { reason, hooks: this.hooks.length });

    this.controller.abort(new Error(`shutdown: ${reason}`));

    const timeout = setTimeout(() => {
      this.logger.error(undefined, 'shutdown timed out, forcing exit', { reason });
      process.exit(1);
    }, this.timeoutMs);
    timeout.unref?.();

    // 逆序执行：后注册的（更外层）先释放
    for (const hook of this.hooks.slice().reverse()) {
      try {
        await hook.run();
      } catch (err) {
        this.logger.error(err, 'shutdown hook failed', { hook: hook.name });
      }
    }

    clearTimeout(timeout);
    this.logger.info('shutdown complete', { reason });
    process.exit(this.exitCode);
  }
}

export function installProcessSafetyNet(logger: Logger): Lifecycle {
  const lifecycle = new Lifecycle({ logger });
  lifecycle.install();
  return lifecycle;
}
