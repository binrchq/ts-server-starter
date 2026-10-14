/**
 * 健康检查控制器。只做 HTTP 编解码，逻辑全在 HealthService。
 */
import type { Request, Response } from 'express';
import { ok } from '../../shared/http/respond.js';
import { ServiceUnavailableError } from '../../shared/errors.js';
import type { HealthService } from './health.service.js';

export interface HealthController {
  health(req: Request, res: Response): Promise<void>;
  livez(req: Request, res: Response): Promise<void>;
  readyz(req: Request, res: Response): Promise<void>;
}

export function createHealthController(service: HealthService): HealthController {
  return {
    async health(_req, res) {
      const report = await service.report();
      // 依赖不可用时返回 503，让负载均衡把流量摘走
      if (report.status === 'down') {
        throw new ServiceUnavailableError('One or more dependencies are unavailable.', report);
      }
      ok(res, report);
    },

    async livez(_req, res) {
      ok(res, service.liveness());
    },

    async readyz(_req, res) {
      const status = service.readiness();
      if (status.status === 'down') throw new ServiceUnavailableError('Not ready to serve traffic.');
      ok(res, status);
    },
  };
}
