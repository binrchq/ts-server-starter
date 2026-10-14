import type { RouteGroup } from '../../app/routes/route-group.js';
import type { Cache } from '../../infra/cache/types.js';
import type { Logger } from '../../shared/logger.js';
import type { UserRepository } from '../auth/user.repository.js';
import { createUserController, type UserController } from './user.controller.js';
import { UserService } from './user.service.js';
import { listUsersQuerySchema, updateProfileBodySchema, userIdParamSchema } from './user.schema.js';

export * from './user.controller.js';
export * from './user.schema.js';
export * from './user.service.js';

export interface UserModuleOptions {
  users: UserRepository;
  cache: Cache;
  logger: Logger;
}

export interface UserModule {
  service: UserService;
  controller: UserController;
  /** 用户自身的接口（outer 端口） */
  mount(group: RouteGroup): void;
  /**
   * 管理端接口，单独一个方法的原因：
   * 同一个路径在 outer 与 admin 端口上的前缀不同（`/api/v1/admin/users` vs `/admin/users`），
   * 而且把「我能改自己」和「管理员能查所有人」混在一个 mount 里，
   * 很容易在新增路由时漏掉 access 声明。
   */
  mountAdmin(group: RouteGroup): void;
}

export function createUserModule(options: UserModuleOptions): UserModule {
  const service = new UserService(options);
  const controller = createUserController(service);

  return {
    service,
    controller,
    mount(group) {
      group.get('/user/profile', controller.profile, { access: 'user', description: '我的资料' });
      group.patch('/user/profile', controller.update, {
        access: 'user',
        schemas: { body: updateProfileBodySchema },
        description: '更新我的资料',
      });
    },

    mountAdmin(group) {
      // access: 'admin' 由 group 默认值给出，逐个路由再声明一次是冗余的
      group.get('/users', controller.list, { schemas: { query: listUsersQuerySchema }, description: '用户列表' });
      group.get('/users/:id', controller.getById, { schemas: { params: userIdParamSchema }, description: '用户详情' });
    },
  };
}
