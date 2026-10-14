/**
 * 令牌签发与校验（HS256 结构，node:crypto 实现，零依赖）。
 *
 * 安全要点（每一条都对应一个真实漏洞类别）：
 *  1. header.alg 必须**固定**为 HS256 —— 不校验 alg 就是经典的 `alg: none` 伪造漏洞
 *  2. 签名比对用 timingSafeEqual —— 避免逐字节爆破
 *  3. 必须校验 exp / nbf —— 否则过期令牌永久有效
 *  4. 必须校验 iss —— 否则同一密钥签发的其它系统令牌可跨系统使用
 *  5. 必须校验 aud —— access 与 refresh 是两种权限，靠 roles 里的魔法字符串
 *     区分太脆弱：一旦有人往 roles 里加了 "refresh"，refresh 令牌就能当 access 用
 *  6. 解析后立即丢弃 header，不参与任何业务判断
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '../../shared/errors.js';

/**
 * 令牌受众。用显式字段而不是「roles 里塞个 refresh」——
 * 前者是类型系统能保证的，后者只能靠约定。
 */
export type TokenAudience = 'access' | 'refresh';

export interface TokenPayload {
  /** subject：用户 ID */
  sub: string;
  /** 受众：access 用于接口鉴权，refresh 只能换令牌 */
  aud: TokenAudience;
  roles: string[];
  scopes?: string[];
  /** 签发者 */
  iss: string;
  /** issued at / expires at / not before（秒） */
  iat: number;
  exp: number;
  nbf?: number;
  /** 令牌 ID，便于黑名单/审计关联 */
  jti: string;
}

export interface SignOptions {
  ttlSeconds?: number;
  notBefore?: Date;
  scopes?: string[];
  /** 默认 access */
  audience?: TokenAudience;
}

export interface VerifyOptions {
  /** 只接受该受众的令牌；不传则接受任意受众（仅限内部调用） */
  audience?: TokenAudience;
}

export interface TokenSigner {
  sign(subject: string, roles: string[], options?: SignOptions): string;
  /** 校验失败抛 UnauthorizedError（message 不泄露具体原因给客户端） */
  verify(token: string, options?: VerifyOptions): TokenPayload;
  /** 校验失败返回 null（用于「可选认证」场景） */
  tryVerify(token: string, options?: VerifyOptions): TokenPayload | null;
}

const ALGORITHM = 'HS256';
/** 允许的时钟偏移（秒），避免多实例间时间不同步导致刚签发的令牌被判过期 */
const CLOCK_SKEW_SECONDS = 30;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function createTokenSigner(secret: string, issuer: string): TokenSigner {
  if (!secret || secret.length < 32) {
    // 弱密钥等于没有签名：直接拒绝构造，避免"能跑但形同虚设"
    throw new Error('token signer requires a secret of at least 32 characters');
  }

  const signature = (data: string): string => createHmac('sha256', secret).update(data).digest('base64url');

  const verify = (token: string, options: VerifyOptions = {}): TokenPayload => {
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedError('Malformed token.');
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

    let header: { alg?: string; typ?: string };
    try {
      header = JSON.parse(fromB64url(headerPart).toString('utf8')) as { alg?: string; typ?: string };
    } catch {
      throw new UnauthorizedError('Malformed token header.');
    }
    // 关键：白名单校验算法，拒绝 none / RS256 等一切非预期取值
    if (header.alg !== ALGORITHM) throw new UnauthorizedError('Unsupported token algorithm.');

    const expected = signature(`${headerPart}.${payloadPart}`);
    const provided = Buffer.from(signaturePart, 'base64url');
    const expectedBuf = Buffer.from(expected, 'base64url');
    if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
      throw new UnauthorizedError('Invalid token signature.');
    }

    let payload: TokenPayload;
    try {
      payload = JSON.parse(fromB64url(payloadPart).toString('utf8')) as TokenPayload;
    } catch {
      throw new UnauthorizedError('Malformed token payload.');
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== issuer) throw new UnauthorizedError('Invalid token issuer.');
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < now) {
      throw new UnauthorizedError('Token has expired.');
    }
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SECONDS > now) {
      throw new UnauthorizedError('Token is not valid yet.');
    }
    if (!payload.sub) throw new UnauthorizedError('Token has no subject.');
    // audience 不匹配：例如拿 refresh 令牌直接调业务接口
    if (options.audience !== undefined && payload.aud !== options.audience) {
      throw new UnauthorizedError('Token audience mismatch.');
    }

    return payload;
  };

  return {
    sign(subject, roles, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      const ttl = options.ttlSeconds ?? 3600;
      const payload: TokenPayload = {
        sub: subject,
        aud: options.audience ?? 'access',
        roles,
        ...(options.scopes ? { scopes: options.scopes } : {}),
        iss: issuer,
        iat: now,
        exp: now + ttl,
        ...(options.notBefore ? { nbf: Math.floor(options.notBefore.getTime() / 1000) } : {}),
        jti: randomUUID(),
      };
      const headerPart = b64url(JSON.stringify({ alg: ALGORITHM, typ: 'JWT' }));
      const payloadPart = b64url(JSON.stringify(payload));
      return `${headerPart}.${payloadPart}.${signature(`${headerPart}.${payloadPart}`)}`;
    },
    verify,
    tryVerify(token, options) {
      try {
        return verify(token, options);
      } catch {
        return null;
      }
    },
  };
}
