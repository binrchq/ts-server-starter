import type { RouteGroup } from '../../app/routes/route-group.js';
import type { Database } from '../../infra/database/types.js';
import type { Cache } from '../../infra/cache/types.js';
import type { ServiceManager } from '../../core/service-manager.js';
import type { TimerWheel } from '../../core/timer-wheel.js';
import { createHealthController, type HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

export * from './health.controller.js';
export * from './health.service.js';

export interface HealthModuleOptions {
  database: Database;
  cache: Cache;
  services: ServiceManager;
  timerWheel: TimerWheel;
  version: string;
}

export interface HealthModule {
  controller: HealthController;
  service: HealthService;
  mount(group: RouteGroup): void;
}

export function createHealthModule(options: HealthModuleOptions): HealthModule {
  const service = new HealthService(options);
  const controller = createHealthController(service);

  return {
    service,
    controller,
    mount(group) {
      group.get('/health', controller.health, { description: '完整健康报告（含依赖）' });
      group.get('/livez', controller.livez, { description: '存活探针（不查依赖）' });
      group.get('/readyz', controller.readyz, { description: '就绪探针' });
    },
  };
}
