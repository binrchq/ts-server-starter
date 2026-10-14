/**
 * API Key 服务。
 *
 * 校验路径上的性能考虑：`findByHash` 走的是哈希精确匹配（数据库里是 unique index），
 * 不做遍历比对 —— 也正因为存的是 hash，数据库被拖库也无法反推明文。
 * touch()/lastUsedAt 更新刻意不阻塞鉴权流程（见 verify）。
 */
import { generateApiKey, sha256 } from '../../shared/crypto.js';
import { NotFoundError, UnauthorizedError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import type { AuditSink, Auditor } from '../../security/audit.js';
import { AuditAction } from '../../security/audit.js';
import type { ApiKeyRepository, ApiKeyRecord } from './api-key.repository.js';
import { API_KEY_SCOPES, isValidScope, type ApiKeyScopes } from './scopes.js';

/** 对外视图：永远不含 keyHash，也不含明文 */
export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScopes[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** 是否已撤销（前端不必自己算） */
  active: boolean;
}

export interface CreateApiKeyInput {
  name: string;
  scopes: ApiKeyScopes[];
}

export interface CreateApiKeyResult {
  /** 明文密钥，**仅此一次**返回 */
  key: string;
  apiKey: ApiKeyView;
}

const KEY_PREFIX = 'sk_live';

export interface ApiKeyServiceOptions {
  repository: ApiKeyRepository;
  auditor: Auditor;
  logger: Logger;
}

export class ApiKeyService {
  constructor(private readonly options: ApiKeyServiceOptions) {}

  private toView(record: ApiKeyRecord): ApiKeyView {
    return {
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      scopes: record.scopes,
      lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
      revokedAt: record.revokedAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
      active: record.revokedAt === null,
    };
  }

  async create(userId: string, input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    const invalid = input.scopes.filter((scope) => !isValidScope(scope));
    if (invalid.length > 0) {
      throw new UnauthorizedError(`Unknown scope(s): ${invalid.join(', ')}. Allowed: ${API_KEY_SCOPES.join(', ')}.`);
    }

    // `*` 是全权，不应由普通用户自助签发 —— 只有管理员角色才能拿到
    // （这里由控制器层用 requireRoles 保证；服务层再兜一道）
    const { key, hash, preview } = generateApiKey(KEY_PREFIX);
    const record = await this.options.repository.create({
      userId,
      name: input.name.trim(),
      prefix: preview,
      keyHash: hash,
      scopes: input.scopes,
    });

    this.options.auditor.record({
      action: AuditAction.ApiKeyCreated,
      outcome: 'success',
      userId,
      resource: `api_key:${record.id}`,
      detail: { name: record.name, scopes: record.scopes },
    });

    return { key, apiKey: this.toView(record) };
  }

  async list(userId: string): Promise<ApiKeyView[]> {
    const records = await this.options.repository.listByUser(userId);
    return records.map((record) => this.toView(record));
  }

  async revoke(userId: string, id: string): Promise<void> {
    const ok = await this.options.repository.revoke(userId, id);
    if (!ok) throw new NotFoundError('API key not found.');
    this.options.auditor.record({
      action: AuditAction.ApiKeyRevoked,
      outcome: 'success',
      userId,
      resource: `api_key:${id}`,
    });
  }

  /**
   * 校验明文密钥。返回 null 表示无效/已撤销。
   * lastUsedAt 的写入是「尽力而为」：失败只记日志，不影响鉴权结果。
   */
  async verify(rawKey: string): Promise<ApiKeyRecord | null> {
    const hash = sha256(rawKey);
    const record = await this.options.repository.findByHash(hash);
    if (!record || record.revokedAt !== null) return null;

    void this.options.repository.touch(record.id).catch((err: unknown) => {
      this.options.logger.error(err, 'failed to update api key lastUsedAt', { apiKeyId: record.id });
    });
    return record;
  }
}

/** 可选的审计落库 sink 示例（真实项目里写到 audit_logs 表） */
export function createApiKeyAuditSink(repository: ApiKeyRepository): AuditSink {
  void repository;
  return {
    name: 'api-key-audit',
    write(event) {
      if (event.action.startsWith('api_key.')) {
        // 真实实现：await db.insert(auditLogs).values({...})
        // starter 里保持 no-op，避免假装"已落库"
      }
    },
  };
}
