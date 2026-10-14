/**
 * 用户仓储。
 *
 * 定义为接口 + 内存实现：接口是契约，内存实现让 starter 开箱即跑。
 * 真实项目里把 InMemoryUserRepository 换成 PrismaUserRepository 即可，
 * 上层（service/controller）一行都不用改。
 */
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../shared/password.js';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  roles: string[];
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  /** 允许指定 id：预置用户 / 数据导入 / 与外部身份系统对齐时需要 */
  id?: string;
  email: string;
  password: string;
  displayName?: string;
  roles?: string[];
}

export interface ListUsersOptions {
  limit: number;
  offset: number;
  keyword?: string;
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  create(input: CreateUserInput): Promise<UserRecord>;
  update(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'roles' | 'status' | 'passwordHash'>>,
  ): Promise<UserRecord | null>;
  list(options: ListUsersOptions): Promise<{ items: UserRecord[]; total: number }>;
}

/** 邮箱统一小写去空格，避免 "A@x.com" 与 "a@x.com" 变成两个账号 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, UserRecord>();

  async findById(id: string): Promise<UserRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const target = normalizeEmail(email);
    for (const user of this.byId.values()) {
      if (user.email === target) return user;
    }
    return null;
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const now = new Date();
    const user: UserRecord = {
      id: input.id ?? randomUUID(),
      email: normalizeEmail(input.email),
      displayName: input.displayName?.trim() || normalizeEmail(input.email).split('@')[0] || 'user',
      passwordHash: await hashPassword(input.password),
      roles: input.roles ?? ['user'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(user.id, user);
    return user;
  }

  async update(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'roles' | 'status' | 'passwordHash'>>,
  ): Promise<UserRecord | null> {
    const existing = this.byId.get(id);
    if (!existing) return null;
    const updated: UserRecord = { ...existing, ...patch, updatedAt: new Date() };
    this.byId.set(id, updated);
    return updated;
  }

  async list(options: ListUsersOptions): Promise<{ items: UserRecord[]; total: number }> {
    const keyword = options.keyword?.trim().toLowerCase();
    const all = [...this.byId.values()]
      .filter((user) =>
        keyword ? user.email.includes(keyword) || user.displayName.toLowerCase().includes(keyword) : true,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return {
      items: all.slice(options.offset, options.offset + options.limit),
      total: all.length,
    };
  }
}
