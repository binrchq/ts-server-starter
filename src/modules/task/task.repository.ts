/**
 * 任务仓储（内存实现）。
 * 换 Prisma 时只需另写一个实现并替换装配，接口保持不动。
 */
import { randomUUID } from 'node:crypto';
import type { CreateTaskBody, ListTasksQuery, UpdateTaskBody } from './task.schema.js';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface TaskRecord {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRepository {
  findById(id: string): Promise<TaskRecord | null>;
  list(
    ownerId: string,
    query: Pick<ListTasksQuery, 'limit' | 'offset' | 'status' | 'keyword'>,
  ): Promise<{ items: TaskRecord[]; total: number }>;
  create(ownerId: string, input: CreateTaskBody): Promise<TaskRecord>;
  update(id: string, patch: UpdateTaskBody): Promise<TaskRecord | null>;
  delete(id: string): Promise<boolean>;
  /** 找出「已逾期但仍未完成」的任务，供定时器扫描 */
  findOverdue(now: Date, limit: number): Promise<TaskRecord[]>;
  countByStatus(ownerId: string): Promise<Record<TaskStatus, number>>;
}

export class InMemoryTaskRepository implements TaskRepository {
  private readonly byId = new Map<string, TaskRecord>();

  async findById(id: string): Promise<TaskRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async list(ownerId: string, query: Pick<ListTasksQuery, 'limit' | 'offset' | 'status' | 'keyword'>) {
    const keyword = query.keyword?.toLowerCase();
    const all = [...this.byId.values()]
      .filter((task) => task.ownerId === ownerId)
      .filter((task) => (query.status ? task.status === query.status : true))
      .filter((task) =>
        keyword ? task.title.toLowerCase().includes(keyword) || task.description.toLowerCase().includes(keyword) : true,
      )
      .sort((a, b) => b.priority - a.priority || b.createdAt.getTime() - a.createdAt.getTime());

    return { items: all.slice(query.offset, query.offset + query.limit), total: all.length };
  }

  async create(ownerId: string, input: CreateTaskBody): Promise<TaskRecord> {
    const now = new Date();
    const task: TaskRecord = {
      id: randomUUID(),
      ownerId,
      title: input.title,
      description: input.description ?? '',
      status: 'pending',
      priority: input.priority,
      dueAt: input.dueAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(task.id, task);
    return task;
  }

  async update(id: string, patch: UpdateTaskBody): Promise<TaskRecord | null> {
    const existing = this.byId.get(id);
    if (!existing) return null;
    const updated: TaskRecord = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      updatedAt: new Date(),
    };
    this.byId.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }

  async findOverdue(now: Date, limit: number): Promise<TaskRecord[]> {
    return [...this.byId.values()]
      .filter((task) => task.dueAt !== null && task.dueAt.getTime() < now.getTime() && task.status !== 'done')
      .slice(0, limit);
  }

  async countByStatus(ownerId: string): Promise<Record<TaskStatus, number>> {
    const counts: Record<TaskStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const task of this.byId.values()) {
      if (task.ownerId === ownerId) counts[task.status] += 1;
    }
    return counts;
  }
}
