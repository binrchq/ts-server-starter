/**
 * 配置定义与校验。
 *
 * 三层结构：
 *   1. defaultConfig()      —— 内置默认值（config.yaml 缺字段时兜底）
 *   2. configSchema (zod)   —— 类型/范围校验，合并完成后统一跑一遍
 *   3. 领域辅助函数          —— configInfo / databaseDsn / validateConfig
 *
 * YAML 里沿用小写下划线（read_timeout），loader 会统一转成 camelCase，
 * 这样配置文件风格与 Go 版一致，而宿主代码是标准 TS 命名。
 */
import { z } from 'zod';

const logLevel = z.enum(['debug', 'info', 'warn', 'error', 'silent']);
const port = z.number().int().min(0).max(65535);

/**
 * NODE_ENV 的行业习惯写法与本模板的枚举不一致：
 * 容器/CI 普遍设 `NODE_ENV=production`，而内部枚举是 `prod`。
 * 不做归一化的话，Dockerfile 里的 `ENV NODE_ENV=production` 会让进程
 * 在 zod 校验阶段直接崩掉 —— 构建成功、容器起不来，只在烟测里才暴露。
 */
const ENVIRONMENT_ALIASES: Record<string, 'dev' | 'test' | 'prod'> = {
  dev: 'dev',
  development: 'dev',
  test: 'test',
  testing: 'test',
  prod: 'prod',
  production: 'prod',
};

function normalizeEnvironment(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return ENVIRONMENT_ALIASES[value.trim().toLowerCase()] ?? value;
}

export const configSchema = z.object({
  environment: z.preprocess(normalizeEnvironment, z.enum(['dev', 'test', 'prod']).default('dev')),

  app: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    nodeId: z.string().min(1),
    description: z.string().default(''),
  }),

  server: z.object({
    host: z.string().min(1),
    /** 0 = 该端口不监听（CLI 生成路由文档时会全部关掉） */
    port,
    mode: z.enum(['debug', 'release', 'test']),
    readTimeoutMs: z.number().int().positive(),
    writeTimeoutMs: z.number().int().positive(),
    /** 0 = 关闭该端口 */
    adminPort: port,
    internalPort: port,
    openapiPort: port,
    metricsPort: port,
    metricsHost: z.string().min(1),
    /**
     * Express 的 trust proxy。生产环境必须显式设置，否则限流会按
     * 反代 IP 统计，等于形同虚设（也可能被 X-Forwarded-For 伪造绕过）。
     */
    trustProxy: z.union([z.boolean(), z.number().int().min(0), z.string()]).default(false),
    /** 请求体大小上限，防止内存耗尽 */
    bodyLimit: z.string().default('1mb'),
  }),

  database: z.object({
    driver: z.enum(['postgres', 'postgresql', 'mysql', 'sqlite', 'sqlite3', 'mongodb', 'prisma']),
    host: z.string().default('localhost'),
    port: port.default(5432),
    name: z.string().default('starter_db'),
    username: z.string().default('postgres'),
    password: z.string().default(''),
    sslMode: z.string().default('disable'),
    schema: z.string().default('public'),
    maxIdleConns: z.number().int().min(0),
    maxOpenConns: z.number().int().min(0),
    connMaxLifetimeMs: z.number().int().min(0),
    connMaxIdleTimeMs: z.number().int().min(0),
    /** 直接给连接串时优先使用（12-factor） */
    url: z.string().default(''),
    /**
     * 动态分表守护。默认关闭 —— 没想清楚分片键就自动建表，
     * 只会得到一堆没人查的空表。
     */
    sharding: z.object({
      enabled: z.boolean(),
      /** 后台巡检间隔：多久检查一次是否需要建下期表 */
      checkIntervalMs: z.number().int().min(1000),
      /** 距期末小于该值时开始准备下期表（默认提前 3 天） */
      prepareAdvanceMs: z.number().int().min(0),
      /** 表名后缀格式：YYYYMM / YYYYMMDD / YYYY_MM / YYYY */
      format: z.string().min(1),
      /** 建表前先做存在性检查（关闭则只依赖 CREATE TABLE IF NOT EXISTS） */
      checkExists: z.boolean(),
    }),
  }),

  redis: z.object({
    host: z.string().min(1),
    port: port,
    password: z.string().default(''),
    database: z.number().int().min(0),
    poolSize: z.number().int().min(1),
    minIdleConns: z.number().int().min(0),
    idleTimeoutMs: z.number().int().min(0),
    url: z.string().default(''),
  }),

  cache: z.object({
    driver: z.enum(['redis', 'memory']),
    database: z.number().int().min(0),
    size: z.number().int().min(1),
    defaultTtlMs: z.number().int().min(0),
    /** 键前缀，多环境共用一套 Redis 时必须设置 */
    keyPrefix: z.string().default(''),
  }),

  mq: z.object({
    driver: z.enum(['memory', 'redis', 'rabbitmq', 'kafka']),
    topicPrefix: z.string().default(''),
    brokers: z.array(z.string()),
    rabbitUrl: z.string().default(''),
  }),

  state: z.object({
    enabled: z.boolean(),
    /**
     * memory：单进程；redis：SET NX PX + Lua CAS；etcd：版本号 CAS + 原生租约。
     * 需要 fencing token / 强一致的 leader election 用 etcd。
     */
    driver: z.enum(['memory', 'redis', 'etcd']),
    lockTtlMs: z.number().int().min(0),
    keyPrefix: z.string().default('state:'),
    /** etcd endpoints，driver=etcd 时必填（如 http://127.0.0.1:2379） */
    endpoints: z.array(z.string()),
  }),

  /** 验证码（短信/邮箱）服务。存储走 state adapter，发送走可替换的 sender。 */
  verification: z.object({
    enabled: z.boolean(),
    /** 验证码位数（4-8，默认 6） */
    length: z.number().int().min(4).max(8),
    ttlMs: z.number().int().min(1000),
    /** 单个验证码允许的校验失败次数，超过即作废（抗暴力枚举） */
    maxAttempts: z.number().int().min(1),
    /** 同一 target 两次发送之间的最小间隔（防短信轰炸） */
    cooldownMs: z.number().int().min(0),
    /** 同一 target 的每日发送上限 */
    dailyLimit: z.number().int().min(1),
    /** 是否把验证码写进日志。仅 dev/test 建议开启，prod 会被强制关闭 */
    exposeInLogs: z.boolean(),
  }),

  logging: z.object({
    level: logLevel,
    format: z.enum(['json', 'text']),
    // stderr：stdout 要留给数据（CLI 一次性命令），日志走 stderr
    output: z.enum(['stdout', 'stderr', 'file']),
    filePath: z.string().default('./logs/app.log'),
    maxSize: z.number().int().positive(),
    maxBackups: z.number().int().min(0),
    maxAge: z.number().int().min(0),
    compress: z.boolean(),
  }),

  /** 安全相关开关（详见 docs/security.md） */
  security: z.object({
    /** 生产环境启动时校验密钥强度 */
    enforceSecrets: z.boolean(),
    sessionSecret: z.string().default(''),
    /** 内网路由共享密钥；为空则 inner 端口全程 503（fail-closed） */
    internalToken: z.string().default(''),
    /** 仅在 TLS 终止可信时开启，否则浏览器会被强制 https，开发环境会被锁死 */
    enableHsts: z.boolean().default(false),
    /** 各路由层的 CORS 白名单 */
    allowedOrigins: z.array(z.string()),
    rateLimit: z.object({
      enabled: z.boolean(),
      windowMs: z.number().int().positive(),
      max: z.number().int().positive(),
      authMax: z.number().int().positive(),
    }),
    auditLog: z.boolean(),
    /**
     * 审计落库队列上限。数据库故障时队列会堆积，
     * 有界队列保证内存不会跟着涨；超出的条数会计入 stats.dropped。
     */
    auditQueueCapacity: z.number().int().min(10).max(100_000),
    /** 攒够多少条写一次库（一次 INSERT 多行） */
    auditBatchSize: z.number().int().min(1).max(1000),
    /** 定时冲刷间隔：低峰期也不能让事件一直躺在内存里 */
    auditFlushIntervalMs: z.number().int().min(100).max(60_000),
    /** 日志里需要打码的字段名（不区分大小写） */
    redactKeys: z.array(z.string()),
  }),
});

export type Config = z.infer<typeof configSchema>;
export type ServerConfig = Config['server'];
export type DatabaseConfig = Config['database'];
export type SecurityConfig = Config['security'];
export type LoggingConfig = Config['logging'];

/** 内置默认值 —— 只要求最小可用，其余交给 config.yaml */
export function defaultConfig(): Config {
  return configSchema.parse({
    environment: 'dev',
    app: {
      name: 'ts-server-starter',
      version: 'v0.1.0',
      nodeId: 'node-001',
      description: 'TypeScript microservice starter template',
    },
    server: {
      host: '0.0.0.0',
      port: 4600,
      mode: 'debug',
      readTimeoutMs: 30_000,
      writeTimeoutMs: 30_000,
      adminPort: 0,
      internalPort: 0,
      openapiPort: 0,
      metricsPort: 0,
      metricsHost: '0.0.0.0',
      trustProxy: false,
      bodyLimit: '1mb',
    },
    database: {
      driver: 'postgres',
      maxIdleConns: 10,
      maxOpenConns: 100,
      connMaxLifetimeMs: 3_600_000,
      connMaxIdleTimeMs: 600_000,
      sharding: {
        enabled: false,
        checkIntervalMs: 6 * 3_600_000,
        prepareAdvanceMs: 72 * 3_600_000,
        format: 'YYYYMM',
        checkExists: true,
      },
    },
    redis: {
      host: 'localhost',
      port: 6379,
      database: 0,
      poolSize: 10,
      minIdleConns: 5,
      idleTimeoutMs: 300_000,
    },
    cache: { driver: 'redis', database: 1, size: 1000, defaultTtlMs: 300_000 },
    mq: { driver: 'memory', brokers: ['localhost:9092'] },
    state: { enabled: false, driver: 'memory', lockTtlMs: 30_000, keyPrefix: 'state:', endpoints: [] },
    verification: {
      enabled: true,
      length: 6,
      ttlMs: 300_000,
      maxAttempts: 5,
      cooldownMs: 60_000,
      dailyLimit: 10,
      exposeInLogs: false,
    },
    logging: {
      level: 'debug',
      format: 'json',
      output: 'stdout',
      maxSize: 100,
      maxBackups: 3,
      maxAge: 7,
      compress: true,
    },
    security: {
      enforceSecrets: true,
      enableHsts: false,
      allowedOrigins: [],
      rateLimit: { enabled: true, windowMs: 60_000, max: 300, authMax: 10 },
      auditLog: true,
      auditQueueCapacity: 1000,
      auditBatchSize: 20,
      auditFlushIntervalMs: 2000,
      redactKeys: [
        'password',
        'passwd',
        'secret',
        'token',
        'authorization',
        'cookie',
        'set-cookie',
        'apikey',
        'api_key',
        'accesskey',
        'privatekey',
        'credential',
        'sessionid',
        'session',
        'signature',
        'otp',
        'pin',
        'cardnumber',
        'cvv',
      ],
    },
  });
}

/** 端口冲突检查 —— 多端口架构最常见的配置事故 */
export function validateConfig(cfg: Config): void {
  const entries: Array<[string, number]> = [
    ['server.port', cfg.server.port],
    ['server.admin_port', cfg.server.adminPort],
    ['server.internal_port', cfg.server.internalPort],
    ['server.openapi_port', cfg.server.openapiPort],
    ['server.metrics_port', cfg.server.metricsPort],
  ];
  const seen = new Map<number, string>();
  for (const [name, value] of entries) {
    if (!value) continue;
    const owner = seen.get(value);
    if (owner) throw new Error(`config validation failed: ${name} conflicts with ${owner} on port ${value}`);
    seen.set(value, name);
  }
  if (cfg.database.maxOpenConns > 0 && cfg.database.maxIdleConns > cfg.database.maxOpenConns) {
    throw new Error('config validation failed: database.max_idle_conns must be <= database.max_open_conns');
  }
  if (cfg.state.enabled && cfg.state.driver === 'etcd' && cfg.state.endpoints.length === 0) {
    throw new Error('config validation failed: state.driver=etcd requires at least one state.endpoints entry');
  }
  if (cfg.verification.enabled && cfg.environment === 'prod' && cfg.verification.exposeInLogs) {
    // 验证码进日志 = 谁拿到日志谁就能登录。生产环境直接把它按死，而不是只打 WARN。
    throw new Error('config validation failed: verification.expose_in_logs must be false in production');
  }
}

/**
 * 启动日志用的脱敏摘要（绝不含密码/密钥）。
 *
 * `source` 是实际读到的配置文件路径。带上它，「配置改了没生效」这类问题
 * 从「猜」变成「看一眼日志」——最常见的原因是进程读的是另一份文件。
 */
export function configInfo(cfg: Config, source?: string | null): Record<string, unknown> {
  return {
    environment: cfg.environment,
    app: `${cfg.app.name}@${cfg.app.version}`,
    configFile: source ?? '(defaults + env only)',
    ports: {
      outer: cfg.server.port,
      admin: cfg.server.adminPort || null,
      inner: cfg.server.internalPort || null,
      openapi: cfg.server.openapiPort || null,
      metrics: cfg.server.metricsPort || null,
    },
    database: `${cfg.database.driver}://${cfg.database.host}:${cfg.database.port}/${cfg.database.name}`,
    sharding: cfg.database.sharding.enabled ? cfg.database.sharding.format : false,
    redis: cfg.redis.url ? 'url' : `${cfg.redis.host}:${cfg.redis.port}`,
    cache: cfg.cache.driver,
    mq: cfg.mq.driver,
    state: cfg.state.driver,
    verification: cfg.verification.enabled,
    logging: `${cfg.logging.level}/${cfg.logging.format}/${cfg.logging.output}`,
  };
}

/** 构造数据库连接串 */
export function databaseDsn(db: DatabaseConfig): string {
  if (db.url) return db.url;
  if (['postgres', 'postgresql', 'prisma'].includes(db.driver)) {
    const params = new URLSearchParams({ sslmode: db.sslMode });
    if (db.schema && db.schema !== 'public') params.set('schema', db.schema);
    return `postgresql://${encodeURIComponent(db.username)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.name}?${params.toString()}`;
  }
  if (db.driver === 'mongodb') {
    return `mongodb://${encodeURIComponent(db.username)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.name}`;
  }
  if (db.driver === 'mysql') {
    return `mysql://${encodeURIComponent(db.username)}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.name}`;
  }
  if (db.driver === 'sqlite' || db.driver === 'sqlite3') {
    // sqlite 用文件路径而不是 host/port：写错协议串比报错更难排查
    return `sqlite://${db.name}`;
  }
  // 明确报错：以前这里会静默回退成 mysql://undefined:...，
  // 结果是「连不上」和「连错了协议」混在一起，排查成本极高
  throw new Error(`unsupported database driver for DSN: ${String(db.driver)}`);
}

/** 基础设施子配置的类型别名：驱动实现只依赖自己那一小片配置，不必 import 整个 Config */
export type RedisConfig = Config['redis'];
export type CacheConfig = Config['cache'];
export type MessagingConfig = Config['mq'];
export type StateConfig = Config['state'];
export type VerificationConfig = Config['verification'];
export type ShardingConfig = Config['database']['sharding'];
