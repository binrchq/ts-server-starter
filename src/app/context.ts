/**
 * 应用上下文（“内核”）。
 *
 * 只放**横切**依赖：配置、日志、DI 容器、安全子系统、服务编排、定时器。
 * 业务模块自己的依赖（数据库、缓存、MQ…）应当通过容器 token 解析 ——
 * 这样单个 controller 的依赖才能一眼看清，而不是从一个大对象里随便摸。
 */
import type { Config } from '../config/schema.js';
import type { Container } from '../core/container.js';
import type { ServiceManager } from '../core/service-manager.js';
import type { TimerWheel } from '../core/timer-wheel.js';
import type { SecurityStack } from '../security/index.js';
import type { Logger } from '../shared/logger.js';

export interface AppContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly container: Container;
  readonly security: SecurityStack;
  readonly services: ServiceManager;
  readonly timerWheel: TimerWheel;
}
