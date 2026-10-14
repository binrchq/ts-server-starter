/**
 * 服务生命周期抽象。
 *
 * Go 版每个服务都要自己维护 `running bool` + `lastErr error` + ctx 判断，
 * 二十行里有一半是样板。这里把簿记收进 AbstractService，具体服务只需要
 * 实现 onStart / onStop 两件事，通常十几行就够。
 */
import type { ServiceContext } from './context.js';

export interface Service {
  readonly name: string;
  readonly isRunning: boolean;
  readonly lastError: unknown;
  /** 幂等：重复 start 应当直接返回 */
  start(ctx: ServiceContext): Promise<void>;
  /** 幂等：未运行时 stop 应当直接返回 */
  stop(ctx: ServiceContext): Promise<void>;
}

export abstract class AbstractService implements Service {
  abstract readonly name: string;

  private running = false;
  private lastErr: unknown = null;

  get isRunning(): boolean {
    return this.running;
  }

  get lastError(): unknown {
    return this.lastErr;
  }

  async start(ctx: ServiceContext): Promise<void> {
    if (this.running) return;
    try {
      await this.onStart(ctx);
      this.running = true;
      this.lastErr = null;
      ctx.logger.debug('service started', { service: this.name });
    } catch (err) {
      this.lastErr = err;
      this.running = false;
      throw err;
    }
  }

  async stop(ctx: ServiceContext): Promise<void> {
    if (!this.running) return;
    try {
      await this.onStop(ctx);
    } catch (err) {
      this.lastErr = err;
      ctx.logger.error(err, 'service stop failed', { service: this.name });
    } finally {
      this.running = false;
      ctx.logger.debug('service stopped', { service: this.name });
    }
  }

  /** 子类实现：建立连接、监听端口等 */
  protected abstract onStart(ctx: ServiceContext): Promise<void>;
  /** 子类实现：释放资源。允许抛错，会被记录但不会阻断其它服务停止 */
  protected abstract onStop(ctx: ServiceContext): Promise<void>;
}

/**
 * 把一个普通异步函数包装成 Service（用于「一次性任务」型服务，
 * 例如迁移检查、预热缓存）。
 */
export class FunctionalService extends AbstractService {
  readonly name: string;
  private readonly startFn: (ctx: ServiceContext) => Promise<void>;
  private readonly stopFn?: (ctx: ServiceContext) => Promise<void>;

  constructor(
    name: string,
    startFn: (ctx: ServiceContext) => Promise<void>,
    stopFn?: (ctx: ServiceContext) => Promise<void>,
  ) {
    super();
    this.name = name;
    this.startFn = startFn;
    this.stopFn = stopFn;
  }

  protected onStart(ctx: ServiceContext): Promise<void> {
    return this.startFn(ctx);
  }

  protected onStop(ctx: ServiceContext): Promise<void> {
    return this.stopFn?.(ctx) ?? Promise.resolve();
  }
}
