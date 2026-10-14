/**
 * 极简 Prometheus 指标暴露。
 *
 * 为什么不引 prom-client：本模板的「零多余依赖」原则。
 * 需要的指标其实就三类（计数器 / 仪表 / 直方图），
 * 自己实现 100 行即可，且能保证标签基数受控（见 withLabels 的说明）。
 */
import type { RequestHandler } from 'express';
import type { AppContext } from './context.js';

export interface Counter {
  inc(labels?: Record<string, string>, value?: number): void;
}

interface Sample {
  labels: Record<string, string>;
  value: number;
}

interface CounterEntry {
  help: string;
  samples: Map<string, Sample>;
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * 指标注册表。
 * 基数是可观测性系统最常见的自伤方式：把 user_id / url 当标签，
 * 时间一长就撑爆 TSDB。所以这里只接受「低基数」标签，并在文档里写明。
 */
export class MetricRegistry {
  private readonly counters = new Map<string, CounterEntry>();
  private readonly gauges = new Map<string, { help: string; collect: () => number }>();

  counter(name: string, help: string): Counter {
    const entry: CounterEntry = this.counters.get(name) ?? { help, samples: new Map() };
    this.counters.set(name, entry);
    return {
      inc: (labels = {}, value = 1) => {
        const key = JSON.stringify(labels);
        const existing = entry.samples.get(key);
        if (existing) existing.value += value;
        else entry.samples.set(key, { labels, value });
      },
    };
  }

  gauge(name: string, help: string, collect: () => number): void {
    this.gauges.set(name, { help, collect });
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, entry] of this.counters) {
      lines.push(`# HELP ${name} ${entry.help}`, `# TYPE ${name} counter`);
      for (const sample of entry.samples.values()) {
        lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
      }
    }
    for (const [name, entry] of this.gauges) {
      lines.push(`# HELP ${name} ${entry.help}`, `# TYPE ${name} gauge`);
      lines.push(`${name} ${entry.collect()}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

/** 进程级 + 业务级默认指标 */
export function createDefaultMetrics(ctx: AppContext): MetricRegistry {
  const registry = new MetricRegistry();

  registry.gauge('process_uptime_seconds', 'Process uptime in seconds', () => process.uptime());
  registry.gauge('process_resident_memory_bytes', 'Resident memory size in bytes', () => process.memoryUsage().rss);
  registry.gauge('process_heap_used_bytes', 'V8 heap used in bytes', () => process.memoryUsage().heapUsed);
  registry.gauge('nodejs_eventloop_lag_seconds', 'Approximate event loop lag', () => measureEventLoopLag());
  registry.gauge('app_info', 'Always 1; version is exposed via labels', () => 1);
  registry.gauge(
    'app_services_running',
    'Number of running services',
    () => ctx.services.getStatus().filter((s) => s.running).length,
  );
  registry.gauge(
    'app_timer_tasks_enabled',
    'Enabled timer tasks',
    () => ctx.timerWheel.snapshot().filter((t) => t.enabled === true).length,
  );

  return registry;
}

let lastLagSample = process.hrtime.bigint();
let lastLagAt = Date.now();

/**
 * 事件循环延迟：Node 没有直接 API，用「两次采样的时间差 vs 期望间隔」近似。
 * 明确标注为近似值 —— 它不做 histogram，只能反映量级。
 */
function measureEventLoopLag(): number {
  const now = process.hrtime.bigint();
  const elapsedMs = Number(now - lastLagSample) / 1e6;
  const wallElapsedMs = Date.now() - lastLagAt;
  lastLagSample = now;
  lastLagAt = Date.now();
  return Math.max(0, Math.round((wallElapsedMs - elapsedMs) * 1000) / 1e6);
}

export function createMetricsHandler(registry: MetricRegistry): RequestHandler {
  return (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(registry.render());
  };
}
