/**
 * 路由层的依赖集合。
 *
 * 显式列出「这一层需要哪些模块」，而不是把整个容器传下去 ——
 * 这样打开 router.ts 就能看清该端口暴露了什么能力。
 */
import type { AppContext } from '../../context.js';
import type { RouteGuards } from '../route-group.js';
import type { RouteRegistry } from '../registry.js';
import type { HealthModule } from '../../../modules/health/index.js';
import type { AuthModule } from '../../../modules/auth/index.js';
import type { UserModule } from '../../../modules/user/index.js';
import type { TaskModule } from '../../../modules/task/index.js';
import type { ApiKeyModule } from '../../../modules/api-key/index.js';
import type { VerificationModule } from '../../../modules/verification/index.js';
import type { AuditModule } from '../../../modules/audit/index.js';

export interface Modules {
  health: HealthModule;
  auth: AuthModule;
  user: UserModule;
  task: TaskModule;
  apiKey: ApiKeyModule;
  verification: VerificationModule;
  audit: AuditModule;
}

export interface RouterDeps {
  ctx: AppContext;
  /** 实际读到的配置文件路径（null 表示只用了默认值 + 环境变量） */
  configSource: string | null;
  guards: RouteGuards;
  registry: RouteRegistry;
  modules: Modules;
}
