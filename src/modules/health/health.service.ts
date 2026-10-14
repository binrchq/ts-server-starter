/**
 * 健康检查。
 *
 * 刻意区分三个端点，别把它们混成一个（这是最常见的运维事故来源）：
 *   /health  存活 + 关键依赖状态，供 K8s readinessProbe
 *   /livez   进程是否活着（不查依赖，否则依赖抖动会导致无限重启）
 *   /readyz  是否可接流量（查依赖）
 */
import type { Cache } from '../../infra/cache/types.js';
import type { Database } from '../../infra/database/types.js';
import type { ServiceManager } from '../../core/service-manager.js';
import type { TimerWheel } from '../../core/timer-wheel.js';

export type DependencyState = 'up' | 'down' | 'degraded' | 'disabled';

export interface DependencyStatus {
  name: string;
  state: DependencyState;
  latencyMs?: number;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  uptimeSeconds: number;
  timestamp: string;
  dependencies: DependencyStatus[];
  services: ReturnType<ServiceManager['getStatus']>;
  timers: Array<Record<string, unknown>>;
}

export interface HealthServiceOptions {
  database: Database;
  cache: Cache;
  services: ServiceManager;
  timerWheel: TimerWheel;
  /** 版本号，来自配置 */
  version: string;
}

export class HealthService {
  constructor(private readonly options: HealthServiceOptions) {}

  async checkDependency(name: string, probe: () => Promise<void>, optional = false): Promise<DependencyStatus> {
    const startedAt = Date.now();
    try {
      await probe();
      return { name, state: 'up', latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        name,
        state: optional ? 'disabled' : 'down',
        latencyMs: Date.now() - startedAt,
        error: (err as Error).message,
      };
    }
  }

  /** 完整报告（readiness 口径：任一关键依赖 down 则整体 down） */
  async report(): Promise<HealthReport> {
    const dependencies = await Promise.all([
      this.checkDependency('database', () => this.options.database.ping()),
      this.checkDependency('cache', async () => {
        const key = '__health_probe__';
        await this.options.cache.set(key, Date.now(), 5000);
        await this.options.cache.get(key);
      }),
    ]);

    const hasDown = dependencies.some((d) => d.state === 'down');
    return {
      status: hasDown ? 'down' : 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dependencies,
      services: this.options.services.getStatus(),
      timers: this.options.timerWheel.snapshot(),
    };
  }

  /** 轻量存活探针：不查任何外部依赖 */
  liveness(): { status: 'ok'; uptimeSeconds: number; version: string; pid: number } {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version: this.options.version,
      pid: process.pid,
    };
  }

  readiness(): { status: 'ok' | 'down'; timestamp: string } {
    const down = this.options.services.getStatus().some((s) => !s.running);
    return { status: down ? 'down' : 'ok', timestamp: new Date().toISOString() };
  }
}
