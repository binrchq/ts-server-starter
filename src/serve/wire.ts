/**
 * 依赖装配（对应 go-starter 的 wire.go / wire_gen.go）。
 *
 * 这是整个模板里唯一允许「知道所有东西」的地方：
 * 谁依赖谁、谁先启动，都在这里一次说清。
 * 其它文件只依赖接口或容器 token，因此可以单独测试、单独替换实现。
 *
 * 与 Wire 的取舍：编译期检查换成了启动期检查，
 * 所以这里显式调用 container.warmup()（见 serve.ts）—— 装配写错会在启动时
 * 立刻失败，而不是等某个请求打进来才 500。
 */
import { loadConfigDetailed, type LoadConfigOptions } from '../config/loader.js';
import type { Config } from '../config/schema.js';
import { validateConfig } from '../config/schema.js';
import { Container } from '../core/container.js';
import { ServiceManager } from '../core/service-manager.js';
import { TimerWheel } from '../core/timer-wheel.js';
import { TimerWheelService } from '../core/timer-wheel-service.js';
import {
  AppContextToken,
  CacheToken,
  ConfigToken,
  DatabaseToken,
  LoggerToken,
  MessageQueueToken,
  RouteRegistryToken,
  SecurityToken,
  ServiceManagerToken,
  StateToken,
  TimerWheelToken,
} from '../core/tokens.js';
import { FunctionalService } from '../core/service.js';
import { createDatabase } from '../infra/database/index.js';
import { ShardRegistry, TablePreparer, TablePreparerService, type ShardDefinition } from '../infra/database/index.js';
import type { Database } from '../infra/database/types.js';
import { createCache } from '../infra/cache/index.js';
import type { Cache } from '../infra/cache/types.js';
import { createMessageQueue } from '../infra/messaging/index.js';
import type { MessageQueue } from '../infra/messaging/types.js';
import { createState } from '../infra/state/index.js';
import type { StateAdapter } from '../infra/state/types.js';
import { createSecurityStack, type SecurityStack } from '../security/index.js';
import { assertSecretsSafe } from '../security/secrets.js';
import { assertCorsConfigured } from '../security/cors.js';
import { createLogger } from '../shared/logger.js';
import type { AppContext } from '../app/context.js';
import { RouteRegistry } from '../app/routes/registry.js';
import type { RouteGuards } from '../app/routes/route-group.js';
import { authenticate, optionalAuthenticate } from '../app/middleware/authenticate.js';
import { requireInternalToken, requireRoles, requireScopes } from '../app/middleware/authorize.js';
import { HttpService, type HttpChannel } from '../app/multi-port.js';
import { createAdminRouter } from '../app/routes/v1/admin/router.js';
import { createInnerRouter } from '../app/routes/v1/inner/router.js';
import { createOpenApiRouter } from '../app/routes/v1/openapi/router.js';
import { createOuterRouter } from '../app/routes/v1/outer/router.js';
import type { Modules } from '../app/routes/v1/types.js';
import { assertDevBypassAllowed, createAuthModule } from '../modules/auth/index.js';
import { InMemoryUserRepository } from '../modules/auth/user.repository.js';
import { createUserModule } from '../modules/user/index.js';
import { createTaskModule } from '../modules/task/index.js';
import { createHealthModule } from '../modules/health/index.js';
import { createApiKeyModule } from '../modules/api-key/index.js';
import { createVerificationModule } from '../modules/verification/index.js';
import type { VerificationCodeSender } from '../modules/verification/index.js';
import { createAuditModule } from '../modules/audit/index.js';
import { SqlAuditRepository } from '../modules/audit/audit.repository.js';
import { createBufferedAuditSink, type BufferedAuditSink } from '../security/audit-sink.js';

export interface WireOptions extends LoadConfigOptions {
  /** 直接传入配置（跳过文件加载） */
  config?: Config;
  /**
   * 基础设施替换点。
   *
   * 这是 DI 的实用之处：集成测试不必为了跑一个 HTTP 用例而拉一个 Postgres，
   * 换掉实现即可 —— 而业务代码完全不知道自己拿到的是真驱动还是替身。
   * 未提供的项按 config 正常创建，所以只替换需要的那一个就行。
   */
  infrastructure?: {
    database?: Database;
    cache?: Cache;
    mq?: MessageQueue;
    state?: StateAdapter;
  };
  /**
   * 分表定义。只有 database.sharding.enabled 时才会被 TablePreparer 使用。
   * 与 go-starter 一样默认留空：要不要分表是业务决定，模板不替你做。
   */
  shards?: ShardDefinition[];
  /**
   * 验证码发送器。默认写日志；生产应在这里注入真实的短信/邮件实现，
   * 而不是改 wire.ts。
   */
  verificationSender?: VerificationCodeSender;
}

export interface WiredApplication {
  config: Config;
  /** 实际读到的配置文件路径（没读文件则为 null）；用于启动日志与 /admin/info */
  configSource: string | null;
  container: Container;
  /** 各端口的挂载定义。集成测试可以拿它自己 listen(0) 起一个临时服务。 */
  channels: HttpChannel[];
  ctx: AppContext;
  modules: Modules;
  guards: RouteGuards;
  registry: RouteRegistry;
  httpService: HttpService;
  timerWheel: TimerWheel;
  security: SecurityStack;
  /** 一次性清理（数据库/缓存/MQ/状态） */
  close(): Promise<void>;
}

/** DEV_AUTH_BYPASS：仅非生产环境可用；生产环境启用会直接抛错 */
function resolveDevBypass(config: Config): { userId: string; roles: string[] } | null {
  const enabled = process.env.DEV_AUTH_BYPASS === '1' || process.env.DEV_AUTH_BYPASS === 'true';
  assertDevBypassAllowed(config.environment, enabled);
  if (!enabled) return null;
  return {
    userId: process.env.DEV_USER_ID ?? 'dev-user-0001',
    roles: (process.env.DEV_USER_ROLES ?? 'user,admin')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
  };
}

export async function wire(options: WireOptions = {}): Promise<WiredApplication> {
  const loaded = options.config
    ? { config: options.config, warnings: [] as string[], source: null }
    : loadConfigDetailed(options);
  const config = loaded.config;
  validateConfig(config);

  // ── 0. 启动自检：不安全的配置必须在启动时就失败
  const secretProblems = assertSecretsSafe(config, { throwOnProblem: config.environment === 'prod' });
  const corsWarning = assertCorsConfigured(config);

  const logger = createLogger({
    level: config.logging.level,
    format: config.logging.format,
    output: config.logging.output,
    filePath: config.logging.filePath,
    maxSize: config.logging.maxSize,
    maxBackups: config.logging.maxBackups,
    maxAge: config.logging.maxAge,
    compress: config.logging.compress,
    base: { app: config.app.name, env: config.environment, node: config.app.nodeId },
  });
  for (const warning of loaded.warnings) logger.warn('configuration warning', { detail: warning });
  for (const problem of secretProblems) {
    logger.warn('insecure secret detected', { secret: problem.name, reason: problem.reason });
  }
  if (corsWarning) logger.warn('cors configuration risk', { detail: corsWarning });

  // ── 1. 容器与基础设施
  const container = new Container();
  container.value(ConfigToken, config);
  container.value(LoggerToken, logger);

  const overrides = options.infrastructure ?? {};
  /** 只关闭自己创建的资源；注入进来的由调用方负责 */
  const owned = { database: false, cache: false, mq: false, state: false };

  const database = overrides.database ?? (await createDatabase(config.database, config.app.name));
  owned.database = overrides.database === undefined;
  container.value(DatabaseToken, database);

  const cacheBundle = overrides.cache
    ? { cache: overrides.cache, close: async (): Promise<void> => undefined }
    : await createCache(config, logger);
  owned.cache = overrides.cache === undefined;
  const { cache, close: closeCache } = cacheBundle;
  container.value(CacheToken, cache);

  const mqBundle = overrides.mq
    ? { mq: overrides.mq, close: async (): Promise<void> => undefined }
    : await createMessageQueue(config, logger);
  owned.mq = overrides.mq === undefined;
  const { mq, close: closeMq } = mqBundle;
  container.value(MessageQueueToken, mq);

  const stateBundle = overrides.state
    ? { state: overrides.state, close: async (): Promise<void> => undefined }
    : await createState(config, logger);
  owned.state = overrides.state === undefined;
  const { state, close: closeState } = stateBundle;
  container.value(StateToken, state);

  // ── 审计落库
  //
  // 审计事件除了进日志，还会落一张 audit_logs 表：日志会被轮转删除，
  // 而「谁在什么时候动了什么」属于要长期保留的合规数据。
  // 文档型数据库（mongodb）没有 SQL 方言，此时保持 logger-only 并在
  // /admin/audit/tail 上如实报告 persisted:false，而不是伪造数据。
  let auditSink: BufferedAuditSink | undefined;
  let auditRepository: SqlAuditRepository | undefined;
  if (database.dialect === 'sql' && config.security.auditLog) {
    auditRepository = new SqlAuditRepository(database);
    auditSink = createBufferedAuditSink({
      writer: auditRepository,
      logger,
      capacity: config.security.auditQueueCapacity,
      batchSize: config.security.auditBatchSize,
      flushIntervalMs: config.security.auditFlushIntervalMs,
    });
  }

  const security = createSecurityStack(config, logger, {
    https: config.security.enableHsts,
    extraAuditSinks: auditSink ? [auditSink] : [],
  });
  container.value(SecurityToken, security);

  const serviceManager = new ServiceManager({ logger });
  container.value(ServiceManagerToken, serviceManager);

  const timerWheel = new TimerWheel({ logger, taskTimeoutMs: 5 * 60_000 });
  container.value(TimerWheelToken, timerWheel);

  const registry = new RouteRegistry();
  container.value(RouteRegistryToken, registry);

  // ── 2. 业务模块
  const users = new InMemoryUserRepository();
  const devBypass = resolveDevBypass(config);

  const authModule = createAuthModule({
    users,
    logger,
    auditor: security.auditor,
    // sessionSecret 为空时给一个明确的开发用值；生产环境已被 assertSecretsSafe 拦下
    sessionSecret: config.security.sessionSecret || 'dev-only-insecure-secret-override-me-32chars',
    issuer: config.app.name,
    devBypass,
  });

  // bypass 身份必须真实存在，否则受保护接口会以「账号不存在」401
  await authModule.ensureDevUser();

  const apiKeyModule = createApiKeyModule({ auditor: security.auditor, logger });

  const verificationModule = createVerificationModule({
    config: config.verification,
    state,
    auditor: security.auditor,
    logger,
    sender: options.verificationSender,
  });

  const modules: Modules = {
    health: createHealthModule({
      database,
      cache,
      services: serviceManager,
      timerWheel,
      version: config.app.version,
    }),
    auth: authModule,
    user: createUserModule({ users, cache, logger }),
    apiKey: apiKeyModule,
    verification: verificationModule,
    audit: createAuditModule({ repository: auditRepository, sink: auditSink, logger }),
    task: createTaskModule({
      cache,
      mq,
      auditor: security.auditor,
      logger,
      topicPrefix: config.mq.topicPrefix,
      timerWheel,
    }),
  };

  // ── 3. 应用上下文
  const ctx: AppContext = { config, logger, container, security, services: serviceManager, timerWheel };
  container.value(AppContextToken, ctx);

  // ── 3b. 动态分表守护（可选）
  // 只对 SQL 方言生效：文档型数据库没有「建表」这一步。
  let tablePreparerService: TablePreparerService | null = null;
  if (config.database.sharding.enabled) {
    if (database.dialect !== 'sql') {
      logger.warn('database sharding is enabled but the driver is not SQL; table preparation is skipped', {
        driver: database.driver,
      });
    } else {
      const shardRegistry = new ShardRegistry().register(...(options.shards ?? []));
      const preparer = new TablePreparer({
        database,
        registry: shardRegistry,
        logger,
        checkIntervalMs: config.database.sharding.checkIntervalMs,
        prepareAdvanceMs: config.database.sharding.prepareAdvanceMs,
        format: config.database.sharding.format,
        checkExists: config.database.sharding.checkExists,
      });
      tablePreparerService = new TablePreparerService(preparer, config.database.sharding.checkIntervalMs);
      logger.info('table preparer enabled', {
        shards: shardRegistry.size,
        format: config.database.sharding.format,
        checkIntervalMs: config.database.sharding.checkIntervalMs,
      });
    }
  }

  // ── 4. 路由守卫
  const guards: RouteGuards = {
    authenticate: authenticate({ authenticator: authModule.authenticator, auditor: security.auditor }),
    optionalAuthenticate: optionalAuthenticate({ authenticator: authModule.authenticator }),
    requireRoles: (roles) => requireRoles(roles, { auditor: security.auditor }),
    requireScopes: (scopes) => requireScopes(scopes, { auditor: security.auditor }),
    requireInternalToken: requireInternalToken({ secret: config.security.internalToken }),
    limiters: security.limiters,
  };

  // openapi 层：认证策略换成 API Key（不接受 Cookie / Bearer）
  const openApiGuards: RouteGuards = {
    ...guards,
    authenticate: authenticate({ authenticator: apiKeyModule.authenticator, auditor: security.auditor }),
  };

  // ── 5. HTTP 多端口
  //
  // 路由在这里**先构建**，再交给各端口挂载。原因：
  //  - 路由注册表要在 wire 阶段就完整（`ts-server routes` 不启动服务也能出文档，
  //    admin 端口的路由数也不会因为"还没 listen"而显示 0）
  //  - 同一个 Router 实例被复用时不会重复注册路由
  const routers = {
    outer: createOuterRouter({ ctx, configSource: loaded.source, guards, registry, modules }),
    admin: createAdminRouter({ ctx, configSource: loaded.source, guards, registry, modules }),
    inner: createInnerRouter({ ctx, configSource: loaded.source, guards, registry, modules }),
    openapi: createOpenApiRouter({ ctx, guards: openApiGuards, registry }),
  };

  const channels: HttpChannel[] = [
    {
      layer: 'outer',
      port: config.server.port,
      parseBody: true,
      mount: (app) => app.use(routers.outer),
    },
    {
      layer: 'admin',
      port: config.server.adminPort,
      parseBody: true,
      mount: (app) => app.use(routers.admin),
    },
    {
      layer: 'inner',
      port: config.server.internalPort,
      parseBody: true,
      mount: (app) => app.use(routers.inner),
    },
    {
      layer: 'openapi',
      port: config.server.openapiPort,
      parseBody: true,
      mount: (app) => app.use(routers.openapi),
    },
    {
      layer: 'metrics',
      port: config.server.metricsPort,
      host: config.server.metricsHost,
      parseBody: false,
      rateLimit: false,
      mount: () => {
        /* /metrics 由 HttpService 内置挂载 */
      },
    },
  ];

  const httpService = new HttpService({ ctx, channels });

  // ── 6. 启动期副作用集中在这里，模块构造阶段不产生外部影响
  modules.task.registerTimers(timerWheel);
  const unsubscribeOverdue = await modules.task.service.startOverdueConsumer();

  // ── 7. 服务注册（注册顺序 = 启动顺序；停止时自动逆序）
  if (tablePreparerService) serviceManager.register(tablePreparerService);
  serviceManager
    .register(new TimerWheelService(timerWheel))
    .register(
      new FunctionalService(
        'mq-consumer',
        async () => {
          logger.info('mq consumer ready', { topics: mq.topics });
        },
        async () => {
          await unsubscribeOverdue();
        },
      ),
    )
    .register(httpService);

  return {
    config,
    configSource: loaded.source,
    container,
    channels,
    ctx,
    modules,
    guards,
    registry,
    httpService,
    timerWheel,
    security,
    async close() {
      // 审计队列要最先冲刷：数据库一关就没法再写了。
      // 这一步失败只记日志 —— 关停流程不应该因为审计失败而中断。
      if (auditSink) {
        try {
          await auditSink.close();
        } catch (err) {
          logger.error(err, 'failed to flush audit sink during shutdown');
        }
      }
      // 逆序释放，且只释放自己创建的
      if (owned.mq) await closeMq();
      if (owned.state) await closeState();
      if (owned.cache) await closeCache();
      if (owned.database) await database.close();
    },
  };
}
