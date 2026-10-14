/**
 * API Key 仓储（内存实现）。
 *
 * 存储约定（与真实项目保持一致，别偷懒）：
 *  - **只存哈希**，永不解密回显；明文只在创建时返回一次
 *  - prefix 用于列表展示与日志关联（`sk_live_3f9a2b...`），不是机密
 *  - 撤销用软删除（revokedAt），保留审计线索
 */
import { randomUUID } from 'node:crypto';
import type { ApiKeyScopes } from './scopes.js';

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: ApiKeyScopes[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface ApiKeyRepository {
  create(record: Omit<ApiKeyRecord, 'id' | 'lastUsedAt' | 'revokedAt' | 'createdAt'>): Promise<ApiKeyRecord>;
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  listByUser(userId: string): Promise<ApiKeyRecord[]>;
  revoke(userId: string, id: string): Promise<boolean>;
  touch(id: string): Promise<void>;
}

export class InMemoryApiKeyRepository implements ApiKeyRepository {
  private readonly byId = new Map<string, ApiKeyRecord>();

  async create(input: Omit<ApiKeyRecord, 'id' | 'lastUsedAt' | 'revokedAt' | 'createdAt'>): Promise<ApiKeyRecord> {
    const record: ApiKeyRecord = {
      ...input,
      id: randomUUID(),
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    for (const record of this.byId.values()) {
      if (record.keyHash === keyHash) return record;
    }
    return null;
  }

  async listByUser(userId: string): Promise<ApiKeyRecord[]> {
    return [...this.byId.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async revoke(userId: string, id: string): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record || record.userId !== userId || record.revokedAt) return false;
    record.revokedAt = new Date();
    return true;
  }

  async touch(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.lastUsedAt = new Date();
  }
}
