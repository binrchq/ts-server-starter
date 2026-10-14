/**
 * 基础设施层的依赖令牌。
 *
 * 「令牌集中定义」是 TS 版对 Wire 的替代：装配关系在编译期看不见，
 * 但至少让 **契约** 有一个唯一来源。业务模块自己的令牌定义在各自模块内
 * （见 src/modules/<name>/tokens.ts），避免这里变成一个什么都往里塞的大杂烩。
 */
import type { Config } from '../config/schema.js';
import type { Cache } from '../infra/cache/types.js';
import type { Database } from '../infra/database/types.js';
import type { MessageQueue } from '../infra/messaging/types.js';
import type { StateAdapter } from '../infra/state/types.js';
import type { SecurityStack } from '../security/index.js';
import type { Logger } from '../shared/logger.js';
import { createToken } from './container.js';
import type { AppContext } from '../app/context.js';
import type { RouteRegistry } from '../app/routes/registry.js';
import type { ServiceManager } from './service-manager.js';
import type { TimerWheel } from './timer-wheel.js';

export const ConfigToken = createToken<Config>('config');
export const LoggerToken = createToken<Logger>('logger');
export const DatabaseToken = createToken<Database>('database');
export const CacheToken = createToken<Cache>('cache');
export const MessageQueueToken = createToken<MessageQueue>('messageQueue');
export const StateToken = createToken<StateAdapter>('state');
export const SecurityToken = createToken<SecurityStack>('security');
export const ServiceManagerToken = createToken<ServiceManager>('serviceManager');
export const TimerWheelToken = createToken<TimerWheel>('timerWheel');
export const RouteRegistryToken = createToken<RouteRegistry>('routeRegistry');
export const AppContextToken = createToken<AppContext>('appContext');
