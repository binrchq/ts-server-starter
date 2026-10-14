import type { Request, Response } from 'express';
import { ok } from '../../shared/http/respond.js';
import type { VerificationService } from './verification.service.js';
import type { SendCodeBody, VerifyCodeBody } from './verification.schema.js';

export interface VerificationController {
  send(req: Request, res: Response): Promise<void>;
  verify(req: Request, res: Response): Promise<void>;
}

export function createVerificationController(service: VerificationService): VerificationController {
  return {
    async send(req, res) {
      // 只回打码 target 与有效期，验证码绝不进响应体
      ok(res, await service.issue(req.body as SendCodeBody));
    },
    async verify(req, res) {
      const result = await service.verify(req.body as VerifyCodeBody);
      // 校验失败不抛错，而是返回结构化的 ok=false，方便前端区分原因并展示剩余次数
      ok(res, result);
    },
  };
}
