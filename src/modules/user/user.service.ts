/**
 * 用户服务。
 *
 * 这里演示两个常用套路：
 *  - 读取走缓存（cache.remember 自带防击穿），写操作主动失效
 *  - 领域错误用 AppError 子类表达，控制器无需 if/else 判空
 */
import type { Cache } from '../../infra/cache/types.js';
import { ConflictError, NotFoundError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { normalizeEmail, type UserRepository, type UserRecord } from '../auth/user.repository.js';
import type { PublicUser } from '../auth/auth.service.js';
import type { UpdateProfileBody } from './user.schema.js';

function toPublic(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface UserServiceOptions {
  users: UserRepository;
  cache: Cache;
  logger: Logger;
}

export class UserService {
  constructor(private readonly options: UserServiceOptions) {}

  private cacheKey(userId: string): string {
    return `user:profile:${userId}`;
  }

  async getProfile(userId: string): Promise<PublicUser> {
    return this.options.cache.remember(this.cacheKey(userId), 60_000, async () => {
      const user = await this.options.users.findById(userId);
      if (!user) throw new NotFoundError('User not found.');
      return toPublic(user);
    });
  }

  async updateProfile(userId: string, patch: UpdateProfileBody): Promise<PublicUser> {
    const current = await this.options.users.findById(userId);
    if (!current) throw new NotFoundError('User not found.');

    const changes: Parameters<UserRepository['update']>[1] = {};
    if (patch.displayName !== undefined) changes.displayName = patch.displayName;

    if (patch.email !== undefined) {
      const normalized = normalizeEmail(patch.email);
      if (normalized !== current.email) {
        const owner = await this.options.users.findByEmail(normalized);
        if (owner && owner.id !== userId) throw new ConflictError('This email is already in use.');
        // 邮箱变更应走「验证新邮箱」流程，这里只做占位说明
        this.options.logger.warn('email change requested without verification flow', { userId });
      }
    }

    const updated = await this.options.users.update(userId, changes);
    if (!updated) throw new NotFoundError('User not found.');
    await this.options.cache.del(this.cacheKey(userId));
    this.options.logger.info('profile updated', { userId, fields: Object.keys(changes) });
    return toPublic(updated);
  }

  /** 管理端：分页查看用户 */
  async listUsers(query: { limit: number; offset: number; keyword?: string }) {
    const { items, total } = await this.options.users.list(query);
    return { items: items.map(toPublic), total, limit: query.limit, offset: query.offset };
  }

  async getById(id: string): Promise<PublicUser> {
    const user = await this.options.users.findById(id);
    if (!user) throw new NotFoundError('User not found.');
    return toPublic(user);
  }
}
