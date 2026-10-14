/**
 * 进程编排（对应 go-starter 的 Serve.Loooop()）。
 *
 * 顺序刻意固定：
 *   1. 打印启动摘要（配置已脱敏）
 *   2. 注册关闭钩子（先注册 = 后执行，保证 HTTP 先停、数据库后关）
 *   3. 安装信号与未捕获异常处理
 *   4. warmup 容器（把装配错误挤到启动阶段）
 *   5. 启动所有服务
 *   6. 等待信号
 *
 * 与 Go 版的差异：Go 用 channel 收信号，Node 用 process.on(SIGxxx)，
 * 但语义完全一致（第二次信号强制退出、退出有超时）。
 */
import type { WiredApplication } from './wire.js';
import { Lifecycle } from '../core/lifecycle.js';
import { createServiceContext, type ServiceContext } from '../core/context.js';
import { configInfo } from '../config/schema.js';

export interface ServeOptions {
  /** 优雅退出总超时，默认 20s */
  shutdownTimeoutMs?: number;
}

export class Serve {
  private readonly lifecycle: Lifecycle;
  private readonly logger: WiredApplication['ctx']['logger'];

  constructor(
    private readonly app: WiredApplication,
    private readonly options: ServeOptions = {},
  ) {
    this.logger = app.ctx.logger.component('serve');
    this.lifecycle = new Lifecycle({
      logger: this.logger,
      shutdownTimeoutMs: this.options.shutdownTimeoutMs ?? 20_000,
    });
  }

  get signal(): AbortSignal {
    return this.lifecycle.signal;
  }

  async run(): Promise<void> {
    const { config, configSource, container, httpService, registry, security } = this.app;

    this.logger.info('starting application', {
      ...configInfo(config, configSource),
      pid: process.pid,
      node: process.version,
      eagerDependencies: container.size,
      auditSinks: security.auditor.sinkNames,
    });

    // 关闭钩子按注册顺序的**逆序**执行：
    // 因此先注册「关连接池」，后注册「停服务」，实际执行时先停服务再关连接。
    this.lifecycle
      .onShutdown('infrastructure', async () => {
        this.logger.debug('closing infrastructure');
        await this.app.close();
      })
      .onShutdown('container', async () => {
        await container.dispose();
      })
      .onShutdown('services', async () => {
        await this.stopServices();
      });

    this.lifecycle.install();

    // warmup：把装配错误挤到启动阶段（DI 的代价，这里补回来）
    await container.warmup();

    await this.startServices();

    const ports = httpService.listeningPorts();
    this.logger.info('application ready', {
      ports: ports.map((p) => `${p.layer}:${p.port}`).join(' '),
      routes: registry.list().length,
      auditEnabled: config.security.auditLog,
      rateLimitEnabled: config.security.rateLimit.enabled,
      corsOrigins: config.security.allowedOrigins.length,
      securityStack: security.auditor ? 'active' : 'inactive',
    });
  }

  private serviceContext(): { ctx: ServiceContext; dispose: () => void } {
    return createServiceContext({
      logger: this.logger,
      timeoutMs: 30_000,
      parent: this.lifecycle.signal,
    });
  }

  private async startServices(): Promise<void> {
    const { ctx, dispose } = this.serviceContext();
    try {
      await this.app.ctx.services.startAll(ctx);
    } finally {
      dispose();
    }
  }

  private async stopServices(): Promise<void> {
    const { ctx, dispose } = this.serviceContext();
    try {
      await this.app.ctx.services.stopAll(ctx);
    } finally {
      dispose();
    }
  }
}
