/**
 * 认证服务。
 *
 * 三个安全细节贯穿始终：
 *  1. 登录失败信息统一为 "Invalid email or password." —— 区分「用户不存在」
 *     与「密码错误」等于提供了账号枚举接口
 *  2. 用户不存在时也执行一次哈希校验，抹平响应时间差异（时间侧信道）
 *  3. 返回给上层的用户对象不含 passwordHash（toPublicUser）
 */
import { ConflictError, ForbiddenError, UnauthorizedError } from '../../shared/errors.js';
import { hashPassword, needsRehash, verifyPassword } from '../../shared/password.js';
import type { Logger } from '../../shared/logger.js';
import type { Authenticator, AuthPrincipal } from '../../app/middleware/authenticate.js';
import type { Auditor } from '../../security/audit.js';
import { AuditAction } from '../../security/audit.js';
import type { CreateUserInput, UserRecord, UserRepository } from './user.repository.js';
import type { TokenSigner } from './token.js';

/** 对外暴露的用户视图（永不含口令哈希） */
export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  status: UserRecord['status'];
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface LoginResult {
  user: PublicUser;
  tokens: AuthTokens;
}

/** 用于抹平「用户不存在」的时间差：固定跑一次同等开销的哈希校验 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export interface AuthServiceOptions {
  users: UserRepository;
  signer: TokenSigner;
  logger: Logger;
  /**
   * 审计器。
   *
   * 登录接口为什么必须在这里审计，而不是靠 authenticate 中间件：
   * 登录/注册挂在 **public** 分组上（还没登进去，当然没有令牌），
   * 中间件根本不会跑。而「撞库」的特征恰恰全是这里的失败样本 ——
   * 漏掉这一段等于把最该留的证据丢了。
   */
  auditor: Auditor;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export class AuthService {
  constructor(private readonly options: AuthServiceOptions) {}

  toPublicUser(user: UserRecord): PublicUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      roles: user.roles,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
    };
  }

  async register(input: CreateUserInput): Promise<LoginResult> {
    const existing = await this.options.users.findByEmail(input.email);
    if (existing) {
      this.options.auditor.record({
        action: AuditAction.AuthRegistered,
        outcome: 'failure',
        resource: 'auth:register',
        detail: { reason: 'email already exists', email: input.email },
      });
      throw new ConflictError('An account with this email already exists.');
    }

    const user = await this.options.users.create(input);
    this.options.logger.info('user registered', { userId: user.id, source: 'auth.register' });
    this.options.auditor.record({
      action: AuditAction.AuthRegistered,
      outcome: 'success',
      userId: user.id,
      resource: `user:${user.id}`,
      detail: { email: user.email },
    });
    return this.issue(user);
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.options.users.findByEmail(email);

    if (!user) {
      // 抹平时间差：即使用户不存在也走一次完整校验
      await verifyPassword(password, DUMMY_HASH);
      this.failLogin(email, 'unknown account');
      throw new UnauthorizedError('Invalid email or password.');
    }
    if (user.status !== 'active') {
      this.failLogin(email, 'account disabled', user.id);
      throw new ForbiddenError('This account has been disabled.');
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      this.failLogin(email, 'bad password', user.id);
      throw new UnauthorizedError('Invalid email or password.');
    }

    this.options.auditor.record({
      action: AuditAction.AuthLogin,
      outcome: 'success',
      userId: user.id,
      resource: `user:${user.id}`,
      detail: { email: user.email, source: 'password' },
    });

    // 哈希参数升级：登录成功后静默 rehash，无需用户干预
    if (needsRehash(user.passwordHash)) {
      const passwordHash = await hashPassword(password);
      await this.options.users.update(user.id, { passwordHash });
      this.options.logger.info('password hash upgraded', { userId: user.id });
    }

    return this.issue(user);
  }

  /** 刷新只换发 access token，用户信息从库重读（角色变更能及时生效） */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    // 显式要求 refresh 受众：access 令牌不能拿来续期
    //
    // verify 自己就会抛（签名不对/过期/受众不符），所以审计必须包住它 ——
    // 否则「伪造 refresh 令牌」这种最典型的攻击反而不留痕迹。
    let payload: ReturnType<TokenSigner['verify']>;
    try {
      payload = this.options.signer.verify(refreshToken, { audience: 'refresh' });
    } catch (err) {
      this.options.auditor.record({
        action: AuditAction.AuthFailed,
        outcome: 'failure',
        resource: 'auth:refresh',
        detail: { reason: 'invalid refresh token', error: err instanceof Error ? err.message : 'unknown' },
      });
      throw err;
    }

    const user = await this.options.users.findById(payload.sub);
    if (!user || user.status !== 'active') {
      this.options.auditor.record({
        action: AuditAction.AuthFailed,
        outcome: 'failure',
        userId: payload.sub,
        resource: 'auth:refresh',
        detail: { reason: user ? 'account not active' : 'unknown account' },
      });
      throw new UnauthorizedError('Invalid refresh token.');
    }
    this.options.auditor.record({
      action: AuditAction.AuthRefresh,
      outcome: 'success',
      userId: user.id,
      resource: `user:${user.id}`,
    });
    return this.issueTokens(user);
  }

  /**
   * 登录失败统一入口。
   *
   * detail 里带上尝试的邮箱：撞库分析必须按账号聚合，
   * 只记 IP 无法回答「哪些账号正在被针对」。代价是 audit_logs 含 PII ——
   * 所以该表要有独立的访问控制与保留期限（见 docs/SECURITY.md）。
   */
  private failLogin(email: string, reason: string, userId?: string): void {
    this.options.auditor.record({
      action: AuditAction.AuthFailed,
      outcome: 'failure',
      ...(userId ? { userId } : {}),
      resource: 'auth:login',
      detail: { reason, email },
    });
  }

  /**
   * 登出。
   *
   * 无状态令牌没有服务端会话可销毁 —— 所以这里**只记审计、不做假动作**。
   * 要真正吊销需要 refresh token 白名单（Redis + jti）或改用服务端 session，
   * 在那之前返回 204 + 一条 auth.logout 审计事件是最诚实的做法。
   */
  logout(userId: string): void {
    this.options.auditor.record({
      action: AuditAction.AuthLogout,
      outcome: 'success',
      userId,
      resource: `user:${userId}`,
      detail: { note: 'stateless token: client-side discard only' },
    });
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.options.users.findById(userId);
    if (!user) throw new UnauthorizedError('Account no longer exists.');
    return this.toPublicUser(user);
  }

  private issue(user: UserRecord): LoginResult {
    return { user: this.toPublicUser(user), tokens: this.issueTokens(user) };
  }

  private issueTokens(user: UserRecord): AuthTokens {
    return {
      accessToken: this.options.signer.sign(user.id, user.roles, {
        ttlSeconds: this.options.accessTtlSeconds,
        audience: 'access',
      }),
      // refresh 令牌不携带业务角色：它唯一的能力就是换一对新令牌
      refreshToken: this.options.signer.sign(user.id, [], {
        ttlSeconds: this.options.refreshTtlSeconds,
        audience: 'refresh',
      }),
      tokenType: 'Bearer',
      expiresIn: this.options.accessTtlSeconds,
    };
  }
}

/**
 * 认证策略：把 Authorization: Bearer <token> 解析成 AuthPrincipal。
 *
 * 这里刻意同时支持两种凭据来源，方便在需要时加上 API Key；
 * 注意 **不要** 在查询参数里接受令牌（会进日志、进 referer）。
 */
export interface CreateAuthenticatorOptions {
  signer: TokenSigner;
  /** 开发环境免登录（生产环境启用会直接拒绝启动，见 assertDevBypassAllowed） */
  devBypass?: { userId: string; roles: string[] } | null;
}

export function createTokenAuthenticator(options: CreateAuthenticatorOptions): Authenticator {
  return {
    name: 'hmac-bearer',
    async authenticate(req) {
      const header = req.header('authorization');
      if (header?.toLowerCase().startsWith('bearer ')) {
        const token = header.slice(7).trim();
        if (!token) return null;
        const payload = options.signer.tryVerify(token, { audience: 'access' });
        if (!payload) return null;
        // refresh token 不能当 access token 用
        if (payload.roles.includes('refresh')) return null;

        const principal: AuthPrincipal = {
          userId: payload.sub,
          roles: payload.roles.filter((role) => role !== 'refresh'),
          source: 'bearer',
          ...(payload.scopes ? { scopes: payload.scopes } : {}),
          expiresInSeconds: Math.max(0, payload.exp - Math.floor(Date.now() / 1000)),
        };
        return principal;
      }

      if (options.devBypass) {
        return { userId: options.devBypass.userId, roles: options.devBypass.roles, source: 'dev-bypass' };
      }
      return null;
    },
  };
}

/** 生产环境开启免登录必须直接失败，而不是打条 warning */
export function assertDevBypassAllowed(environment: string, enabled: boolean): void {
  if (enabled && environment === 'prod') {
    throw new Error('DEV_AUTH_BYPASS must not be enabled in production');
  }
}
