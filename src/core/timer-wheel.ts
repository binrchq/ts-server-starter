/**
 * 定时任务调度器。
 *
 * Go 版叫 TimerWheel，实际语义是「带依赖、带并发上限的周期任务表」。
 * 这里用最小堆维护下次触发时间，并把 Go 的几个概念一一对应：
 *
 *   Dependencies  -> dependencies：依赖任务至少成功跑完一轮才允许启动
 *   MaxConcurrent -> 同名任务的并发上限（信号量）
 *   PreCondition  -> precondition：返回 false 则本轮跳过
 *   OnCompleted   -> onCompleted：一次执行结束后的回调（无论成败）
 *
 * 为什么不用 setInterval：任务执行时间可能超过周期，
 * setInterval 会堆积执行；这里每次执行完才排下一轮。
 */
import type { Logger } from '../shared/logger.js';
import { getLogger } from '../shared/logger.js';
import type { ServiceContext } from './context.js';

export interface TimerTaskResult {
  taskId: string;
  ok: boolean;
  startedAt: Date;
  durationMs: number;
  error?: unknown;
}

export interface TimerTask {
  id: string;
  /** 周期，毫秒 */
  intervalMs: number;
  handler: (ctx: ServiceContext) => Promise<void>;
  /** 是否启用，默认 true */
  enabled?: boolean;
  /** 启动时立即执行一次，默认 false */
  immediate?: boolean;
  /** 同名依赖跑完一轮后才开始调度 */
  dependencies?: string[];
  /** 并发上限，默认 1 */
  maxConcurrent?: number;
  /** 返回 false 则跳过本轮 */
  precondition?: (ctx: ServiceContext) => boolean | Promise<boolean>;
  /** 一次执行结束后的钩子（成功或失败都会调用） */
  onCompleted?: (result: TimerTaskResult) => void | Promise<void>;
}

interface ScheduledTask {
  def: TimerTask;
  enabled: boolean;
  intervalMs: number;
  nextRunAt: number;
  lastRunAt: Date | null;
  completed: boolean;
  running: number;
  skipped: number;
  failures: number;
  /** 正在执行、暂时移出堆（避免同一任务被重复触发） */
  parked: boolean;
}

/** 极简二叉最小堆（按 nextRunAt） */
class DeadlineHeap {
  private readonly items: ScheduledTask[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): ScheduledTask | undefined {
    return this.items[0];
  }

  clear(): void {
    this.items.length = 0;
  }

  push(item: ScheduledTask): void {
    this.items.push(item);
    this.up(this.items.length - 1);
  }

  /** 重建堆（改过 key 之后调用） */
  rebuild(): void {
    for (let i = Math.floor(this.items.length / 2) - 1; i >= 0; i -= 1) this.down(i);
  }

  pop(): ScheduledTask | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      this.down(0);
    }
    return top;
  }

  private up(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const current = this.items[i];
      const up = this.items[parent];
      if (!current || !up || up.nextRunAt <= current.nextRunAt) break;
      this.items[i] = up;
      this.items[parent] = current;
      i = parent;
    }
  }

  private down(index: number): void {
    let i = index;
    const n = this.items.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && (this.items[left]?.nextRunAt ?? Infinity) < (this.items[smallest]?.nextRunAt ?? Infinity))
        smallest = left;
      if (right < n && (this.items[right]?.nextRunAt ?? Infinity) < (this.items[smallest]?.nextRunAt ?? Infinity))
        smallest = right;
      if (smallest === i) break;
      const a = this.items[i];
      const b = this.items[smallest];
      if (!a || !b) break;
      this.items[i] = b;
      this.items[smallest] = a;
      i = smallest;
    }
  }
}

export interface TimerWheelOptions {
  logger?: Logger;
  /** 单次任务执行超时，0 表示不限制 */
  taskTimeoutMs?: number;
  /** 最大调度间隔（毫秒），用于兜底唤醒，默认 1000 */
  maxTickMs?: number;
}

export class TimerWheel {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly heap = new DeadlineHeap();
  private readonly logger: Logger;
  private readonly taskTimeoutMs: number;
  private readonly maxTickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ctx: ServiceContext | null = null;

  constructor(options: TimerWheelOptions = {}) {
    this.logger = (options.logger ?? getLogger()).component('timer-wheel');
    this.taskTimeoutMs = options.taskTimeoutMs ?? 0;
    this.maxTickMs = options.maxTickMs ?? 1000;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 注册任务；重复 id 会抛错（早失败好过静默覆盖） */
  add(task: TimerTask): this {
    if (this.tasks.has(task.id)) throw new Error(`timer task "${task.id}" already registered`);
    if (task.intervalMs <= 0) throw new Error(`timer task "${task.id}" must have a positive interval`);

    const now = Date.now();
    const scheduled: ScheduledTask = {
      def: task,
      enabled: task.enabled ?? true,
      intervalMs: task.intervalMs,
      nextRunAt: task.immediate || !task.dependencies?.length ? now : Number.POSITIVE_INFINITY,
      lastRunAt: null,
      completed: false,
      running: 0,
      skipped: 0,
      failures: 0,
      parked: false,
    };
    this.tasks.set(task.id, scheduled);
    this.reschedule(scheduled, now);
    return this;
  }

  remove(id: string): boolean {
    const removed = this.tasks.delete(id);
    if (removed) {
      this.rebuildHeap();
      this.wake();
    }
    return removed;
  }

  enable(id: string, enabled = true): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.enabled = enabled;
    this.logger.info('timer task toggled', { task: id, enabled });
    this.rebuildHeap();
    this.wake();
    return true;
  }

  /** 手动触发一次（不影响既有排期） */
  async runNow(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`timer task "${id}" not found`);
    if (!this.ctx) throw new Error('timer wheel is not running');
    await this.execute(task, this.ctx);
  }

  /** 拓扑排序后的任务快照，供监控端点使用 */
  snapshot(): Array<Record<string, unknown>> {
    return [...this.tasks.values()].map((t) => ({
      id: t.def.id,
      intervalMs: t.intervalMs,
      enabled: t.enabled,
      completed: t.completed,
      running: t.running,
      skipped: t.skipped,
      failures: t.failures,
      lastRunAt: t.lastRunAt?.toISOString() ?? null,
      nextRunAt: Number.isFinite(t.nextRunAt) ? new Date(t.nextRunAt).toISOString() : null,
      dependencies: t.def.dependencies ?? [],
    }));
  }

  start(ctx: ServiceContext): void {
    if (this.running) return;
    this.running = true;
    this.ctx = ctx;

    const now = Date.now();
    for (const task of this.tasks.values()) {
      // 复位：上一次 stop 时可能有任务停在 parked 状态
      task.parked = false;
      task.nextRunAt = task.def.immediate || !task.def.dependencies?.length ? now : Number.POSITIVE_INFINITY;
    }
    this.rebuildHeap();
    this.logger.info('timer wheel started', { tasks: this.tasks.size });
    this.schedule();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.heap.clear();
    this.logger.info('timer wheel stopped');
  }

  private schedule(): void {
    if (!this.running || this.timer) return;

    // 依赖已满足的任务此时才允许进入堆
    const now = Date.now();
    let changed = false;
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (!Number.isFinite(task.nextRunAt)) {
        if (this.dependenciesSatisfied(task)) {
          task.nextRunAt = now;
          changed = true;
        }
      }
    }
    if (changed) this.rebuildHeap();

    const next = this.heap.peek();
    const delay = next ? Math.max(0, Math.min(next.nextRunAt - now, this.maxTickMs)) : this.maxTickMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  /** 有新任务/依赖状态变化时提前唤醒调度循环（注册/开关任务很少发生，直接重排即可） */
  private wake(): void {
    if (!this.running || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.schedule();
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.ctx) return;
    const now = Date.now();

    while (this.running) {
      const top = this.heap.peek();
      if (!top || top.nextRunAt > now) break;
      this.heap.pop();

      if (!top.enabled) continue;

      const capacity = top.def.maxConcurrent ?? 1;
      if (top.running >= capacity) {
        // 上一轮还没跑完，本轮跳过，固定间隔顺延
        top.skipped += 1;
        top.nextRunAt = now + top.intervalMs;
        this.heap.push(top);
        continue;
      }

      // 移出堆 -> 执行 -> 完成后按「固定延迟」重新排期（见 execute 的 finally）
      top.parked = true;
      void this.execute(top, this.ctx);
    }

    this.schedule();
  }

  private dependenciesSatisfied(task: ScheduledTask): boolean {
    const deps = task.def.dependencies ?? [];
    if (deps.length === 0) return true;
    return deps.every((id) => this.tasks.get(id)?.completed === true);
  }

  private async execute(task: ScheduledTask, baseCtx: ServiceContext): Promise<void> {
    const startedAt = new Date();
    task.running += 1;

    const ctx: ServiceContext = {
      ...baseCtx,
      logger: baseCtx.logger.child({ task: task.def.id }),
    };

    try {
      if (task.def.precondition && !(await task.def.precondition(ctx))) {
        task.skipped += 1;
        return;
      }
      await this.withTimeout(task, ctx);
      task.completed = true;
      task.lastRunAt = startedAt;
      await this.notifyCompleted({
        taskId: task.def.id,
        ok: true,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
      });
    } catch (err) {
      task.failures += 1;
      task.lastRunAt = startedAt;
      this.logger.error(err, 'timer task failed', { task: task.def.id, failures: task.failures });
      await this.notifyCompleted({
        taskId: task.def.id,
        ok: false,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        error: err,
      });
    } finally {
      task.running -= 1;
      // 固定延迟：这一轮真正结束后再排下一轮，避免执行时间超过周期时堆积
      task.parked = false;
      task.nextRunAt = Date.now() + task.intervalMs;
      this.rebuildHeap();
      this.wake();
    }
  }

  private async withTimeout(task: ScheduledTask, ctx: ServiceContext): Promise<void> {
    if (this.taskTimeoutMs <= 0) return task.def.handler(ctx);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`timer task "${task.def.id}" timed out`)),
      this.taskTimeoutMs,
    );
    timer.unref?.();
    try {
      await task.def.handler({ ...ctx, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async notifyCompleted(result: TimerTaskResult): Promise<void> {
    const task = this.tasks.get(result.taskId);
    if (!task?.def.onCompleted) return;
    try {
      await task.def.onCompleted(result);
    } catch (err) {
      this.logger.error(err, 'timer task onCompleted hook failed', { task: result.taskId });
    }
  }

  private reschedule(task: ScheduledTask, now: number): void {
    if (task.def.immediate || !task.def.dependencies?.length) {
      task.nextRunAt = now;
    }
    this.rebuildHeap();
    this.wake();
  }

  private rebuildHeap(): void {
    this.heap.clear();
    for (const task of this.tasks.values()) {
      if (!task.parked) this.heap.push(task);
    }
  }
}
