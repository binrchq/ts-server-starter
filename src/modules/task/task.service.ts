/**
 * 任务服务 —— 这个模块同时演示四种基础设施的用法：
 *   cache  —— 统计结果缓存 + 写操作失效
 *   audit  —— 关键变更留痕
 *   mq     —— 状态变化发事件，供其它服务订阅
 *   timer  —— 逾期任务扫描（由 wire 注册到 TimerWheel）
 *
 * 业务规则都集中在这里，控制器与仓储都不含判断逻辑。
 */
import type { Cache } from '../../infra/cache/types.js';
import type { MessageQueue } from '../../infra/messaging/types.js';
import type { Auditor } from '../../security/audit.js';
import { NotFoundError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import type { TaskRepository, TaskRecord, TaskStatus } from './task.repository.js';
import type { CreateTaskBody, ListTasksQuery, UpdateTaskBody } from './task.schema.js';

export interface TaskView {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  dueAt: string | null;
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskServiceOptions {
  repository: TaskRepository;
  cache: Cache;
  mq: MessageQueue;
  auditor: Auditor;
  logger: Logger;
  /** MQ 主题前缀，例如 `starter.dev.` */
  topicPrefix: string;
}

const OVERDUE_TOPIC = 'task.overdue';

export class TaskService {
  constructor(private readonly options: TaskServiceOptions) {}

  private toView(task: TaskRecord): TaskView {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      dueAt: task.dueAt?.toISOString() ?? null,
      overdue: task.dueAt !== null && task.dueAt.getTime() < Date.now() && task.status !== 'done',
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    };
  }

  private statsKey(ownerId: string): string {
    return `task:stats:${ownerId}`;
  }

  async create(ownerId: string, input: CreateTaskBody): Promise<TaskView> {
    const task = await this.options.repository.create(ownerId, input);
    await this.invalidate(ownerId);
    this.options.auditor.record({
      action: 'task.created',
      outcome: 'success',
      userId: ownerId,
      resource: `task:${task.id}`,
      detail: { title: task.title, priority: task.priority },
    });
    await this.publish('task.created', { taskId: task.id, ownerId });
    return this.toView(task);
  }

  async list(ownerId: string, query: ListTasksQuery) {
    const { items, total } = await this.options.repository.list(ownerId, query);
    return { items: items.map((task) => this.toView(task)), total, limit: query.limit, offset: query.offset };
  }

  async get(ownerId: string, id: string): Promise<TaskView> {
    const task = await this.options.repository.findById(id);
    // 越权访问返回 404 而不是 403：不泄露"该 ID 存在"这一信息
    if (!task || task.ownerId !== ownerId) throw new NotFoundError('Task not found.');
    return this.toView(task);
  }

  async update(ownerId: string, id: string, patch: UpdateTaskBody): Promise<TaskView> {
    const existing = await this.options.repository.findById(id);
    if (!existing || existing.ownerId !== ownerId) throw new NotFoundError('Task not found.');

    const updated = await this.options.repository.update(id, patch);
    if (!updated) throw new NotFoundError('Task not found.');

    await this.invalidate(ownerId);
    this.options.auditor.record({
      action: 'task.updated',
      outcome: 'success',
      userId: ownerId,
      resource: `task:${id}`,
      detail: { fields: Object.keys(patch) },
    });
    if (patch.status && patch.status !== existing.status) {
      await this.publish('task.status_changed', { taskId: id, from: existing.status, to: patch.status });
    }
    return this.toView(updated);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const existing = await this.options.repository.findById(id);
    if (!existing || existing.ownerId !== ownerId) throw new NotFoundError('Task not found.');
    await this.options.repository.delete(id);
    await this.invalidate(ownerId);
    this.options.auditor.record({
      action: 'task.deleted',
      outcome: 'success',
      userId: ownerId,
      resource: `task:${id}`,
    });
  }

  /** 统计走缓存：读多写少，且能容忍秒级延迟 */
  async stats(ownerId: string): Promise<Record<TaskStatus, number>> {
    return this.options.cache.remember(this.statsKey(ownerId), 30_000, () =>
      this.options.repository.countByStatus(ownerId),
    );
  }

  /**
   * 定时任务：扫描逾期任务并发事件。
   * 返回处理数量，便于在日志/指标里观察。
   */
  async sweepOverdue(limit = 100): Promise<number> {
    const overdue = await this.options.repository.findOverdue(new Date(), limit);
    for (const task of overdue) {
      await this.publish(OVERDUE_TOPIC, { taskId: task.id, ownerId: task.ownerId, dueAt: task.dueAt?.toISOString() });
    }
    if (overdue.length > 0) {
      this.options.logger.warn('overdue tasks detected', { count: overdue.length });
    }
    return overdue.length;
  }

  /** 订阅逾期事件（演示消费侧写法） */
  async startOverdueConsumer(): Promise<() => Promise<void>> {
    return this.options.mq.subscribe<{ taskId: string; ownerId: string }>(
      this.topic(OVERDUE_TOPIC),
      (message) => {
        this.options.logger.info('received overdue event', { taskId: message.payload.taskId });
      },
      { maxRetries: 3 },
    );
  }

  private topic(name: string): string {
    return `${this.options.topicPrefix}${name}`;
  }

  private async publish(name: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.options.mq.publish(this.topic(name), payload);
    } catch (err) {
      // 事件发布失败不能影响主流程（最终一致由补偿任务兜底）
      this.options.logger.error(err, 'failed to publish event', { topic: name });
    }
  }

  private async invalidate(ownerId: string): Promise<void> {
    await this.options.cache.del(this.statsKey(ownerId));
  }
}
