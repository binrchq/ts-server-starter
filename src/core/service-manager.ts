/**
 * 服务编排。
 *
 * Go 版用 RWMutex 保护 map；Node 单线程下不需要锁，但要保证：
 *   - 启动按注册顺序（依赖方在后），停止按 **逆序**（先停被依赖方）
 *   - 单个服务启动失败时，已启动的服务要回滚停止，不留半启动状态
 *   - start/stop 都幂等，重复调用不会重复执行
 */
import type { Logger } from '../shared/logger.js';
import { getLogger } from '../shared/logger.js';
import type { Service } from './service.js';
import { createServiceContext } from './context.js';
import type { ServiceContext } from './context.js';

export interface ServiceStatus {
  name: string;
  running: boolean;
  lastError: string | null;
}

export interface ServiceManagerOptions {
  logger?: Logger;
  /** 单个服务 start/stop 的超时，默认 30s */
  operationTimeoutMs?: number;
}

export class ServiceManager {
  private readonly services: Service[] = [];
  private readonly byName = new Map<string, Service>();
  private readonly logger: Logger;
  private readonly operationTimeoutMs: number;
  private started = false;

  constructor(options: ServiceManagerOptions = {}) {
    this.logger = (options.logger ?? getLogger()).component('service-manager');
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
  }

  register(service: Service): this {
    if (this.byName.has(service.name)) {
      throw new Error(`service "${service.name}" is already registered`);
    }
    this.services.push(service);
    this.byName.set(service.name, service);
    return this;
  }

  /**
   * 按名字取服务。
   * 之前这里是 `get(names?: readonly string[])` 并返回第一个匹配项 ——
   * 一个「传数组只取第一个」的 API 全项目没人用，却很容易被误当成批量查询，
   * 所以直接删掉，只保留语义明确的 getService()。
   */
  getService(name: string): Service | undefined {
    return this.byName.get(name);
  }

  get names(): string[] {
    return this.services.map((s) => s.name);
  }

  getStatus(): ServiceStatus[] {
    return this.services.map((s) => ({
      name: s.name,
      running: s.isRunning,
      lastError: s.lastError ? String((s.lastError as Error).message ?? s.lastError) : null,
    }));
  }

  getNodeInfo(): Record<string, unknown> {
    const running = this.services.filter((s) => s.isRunning).length;
    return {
      total: this.services.length,
      running,
      stopped: this.services.length - running,
      services: this.getStatus(),
    };
  }

  /**
   * 顺序启动。任何一个失败 → 回滚已启动的部分并抛出，
   * 避免进程处于「一半服务在跑」的不可判定状态。
   */
  async startAll(ctx: ServiceContext): Promise<void> {
    if (this.started) {
      this.logger.warn('startAll called twice, ignoring');
      return;
    }
    const startedServices: Service[] = [];

    for (const service of this.services) {
      const { ctx: scoped, dispose } = createServiceContext({
        logger: this.logger,
        timeoutMs: this.operationTimeoutMs,
        parent: ctx.signal,
        fields: { service: service.name },
      });
      try {
        await service.start(scoped);
        startedServices.push(service);
      } catch (err) {
        this.logger.error(err, 'service start failed, rolling back', { service: service.name });
        await this.stopAll(ctx, startedServices);
        throw err;
      } finally {
        dispose();
      }
    }

    this.started = true;
    this.logger.info('all services started', { count: this.services.length });
  }

  /** 逆序停止；单个失败不影响其他服务 */
  async stopAll(ctx: ServiceContext, subset?: Service[]): Promise<void> {
    const targets = (subset ?? this.services).slice().reverse();
    for (const service of targets) {
      const { ctx: scoped, dispose } = createServiceContext({
        logger: this.logger,
        timeoutMs: this.operationTimeoutMs,
        parent: ctx.signal,
        fields: { service: service.name },
      });
      try {
        await service.stop(scoped);
      } catch (err) {
        this.logger.error(err, 'service stop failed', { service: service.name });
      } finally {
        dispose();
      }
    }
    if (!subset) {
      this.started = false;
      this.logger.info('all services stopped', { count: this.services.length });
    }
  }

  /** 按名字重启单个服务（配置热更新、连接自愈场景） */
  async restart(name: string, ctx: ServiceContext): Promise<void> {
    const service = this.byName.get(name);
    if (!service) throw new Error(`service "${name}" not found`);
    const { ctx: scoped, dispose } = createServiceContext({
      logger: this.logger,
      timeoutMs: this.operationTimeoutMs,
      parent: ctx.signal,
      fields: { service: name },
    });
    try {
      await service.stop(scoped);
      await service.start(scoped);
    } finally {
      dispose();
    }
  }
}
