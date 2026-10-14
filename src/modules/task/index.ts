import type { RouteGroup } from '../../app/routes/route-group.js';
import type { Cache } from '../../infra/cache/types.js';
import type { MessageQueue } from '../../infra/messaging/types.js';
import type { Auditor } from '../../security/audit.js';
import type { Logger } from '../../shared/logger.js';
import type { TimerWheel } from '../../core/timer-wheel.js';
import type { ServiceContext } from '../../core/context.js';
import { createTaskController, type TaskController } from './task.controller.js';
import { TaskService } from './task.service.js';
import { InMemoryTaskRepository, type TaskRepository } from './task.repository.js';
import { createTaskBodySchema, listTasksQuerySchema, taskIdParamSchema, updateTaskBodySchema } from './task.schema.js';

export * from './task.controller.js';
export * from './task.repository.js';
export * from './task.schema.js';
export * from './task.service.js';

export interface TaskModuleOptions {
  repository?: TaskRepository;
  cache: Cache;
  mq: MessageQueue;
  auditor: Auditor;
  logger: Logger;
  topicPrefix: string;
  timerWheel?: TimerWheel;
  /** 逾期扫描周期，默认 60s */
  sweepIntervalMs?: number;
}

export interface TaskModule {
  service: TaskService;
  controller: TaskController;
  mount(group: RouteGroup): void;
  /** 注册定时任务（由 serve 阶段调用，避免模块构造时就产生副作用） */
  registerTimers(timerWheel: TimerWheel): void;
}

export function createTaskModule(options: TaskModuleOptions): TaskModule {
  const service = new TaskService({
    repository: options.repository ?? new InMemoryTaskRepository(),
    cache: options.cache,
    mq: options.mq,
    auditor: options.auditor,
    logger: options.logger,
    topicPrefix: options.topicPrefix,
  });
  const controller = createTaskController(service);

  return {
    service,
    controller,
    mount(group) {
      group.get('/tasks', controller.list, {
        access: 'user',
        schemas: { query: listTasksQuerySchema },
        description: '任务列表',
      });
      group.post('/tasks', controller.create, {
        access: 'user',
        schemas: { body: createTaskBodySchema },
        description: '创建任务',
      });
      group.get('/tasks/stats', controller.stats, { access: 'user', description: '任务统计（缓存 30s）' });
      group.get('/tasks/:id', controller.get, {
        access: 'user',
        schemas: { params: taskIdParamSchema },
        description: '任务详情',
      });
      group.patch('/tasks/:id', controller.update, {
        access: 'user',
        schemas: { params: taskIdParamSchema, body: updateTaskBodySchema },
        description: '更新任务',
      });
      group.delete('/tasks/:id', controller.remove, {
        access: 'user',
        schemas: { params: taskIdParamSchema },
        description: '删除任务',
      });
    },
    registerTimers(timerWheel) {
      timerWheel.add({
        id: 'task.sweep-overdue',
        intervalMs: options.sweepIntervalMs ?? 60_000,
        handler: async (_ctx: ServiceContext) => {
          await service.sweepOverdue();
        },
        onCompleted: (result) => {
          if (!result.ok) options.logger.error(result.error, 'overdue sweep failed');
        },
      });
    },
  };
}
