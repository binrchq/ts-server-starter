/**
 * Express Request 扩展。
 * 只挂「中间件写入、后续 handler 读取」的字段，保持类型安全。
 */
import type { AuthPrincipal } from '../app/middleware/authenticate.js';
import type { Logger } from '../shared/logger.js';

declare global {
  namespace Express {
    interface Request {
      /** requestId 中间件写入 */
      requestId?: string;
      /** authenticate 中间件写入（简版，只含 userId） */
      user?: { userId: string };
      /** authenticate 中间件写入（完整凭证信息） */
      principal?: AuthPrincipal;
      /** 请求级 logger（可选，未设置时用全局 logger） */
      requestLogger?: Logger;
    }
  }
}

export {};
