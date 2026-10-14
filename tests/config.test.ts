/**
 * 配置加载的测试重点不是「能读出值」，而是几条容易被忽略的约定：
 * 优先级、snake→camel、按目标类型转换、未知路径忽略、危险配置被拦。
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, loadConfigDetailed } from '../src/config/loader.js';
import { configInfo, databaseDsn, defaultConfig, validateConfig } from '../src/config/schema.js';

describe('config loader', () => {
  it('内置默认值可用且不需要任何外部文件', () => {
    const config = loadConfig({ env: {} });
    expect(config.app.name).toBeTruthy();
    expect(config.server.port).toBeGreaterThan(0);
    expect(config.logging.level).toBeTruthy();
  });

  it('环境变量按双下划线映射层级，并把 snake_case 转成 camelCase', () => {
    const config = loadConfig({
      env: {
        SERVER__ADMIN_PORT: '3999',
        DATABASE__HOST: 'db.internal',
        LOGGING__LEVEL: 'warn',
      },
    });
    expect(config.server.adminPort).toBe(3999);
    expect(config.database.host).toBe('db.internal');
    expect(config.logging.level).toBe('warn');
  });

  it('类型按目标字段推断：数字端口、布尔开关、数组都正确转换', () => {
    const config = loadConfig({
      env: {
        SERVER__PORT: '8080',
        SERVER__TRUST_PROXY: 'true',
        SECURITY__ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com',
      },
    });
    expect(config.server.port).toBe(8080);
    expect(config.server.trustProxy).toBe(true);
    expect(config.security.allowedOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('拼错的路径被忽略，而不是注入未知字段', () => {
    const config = loadConfig({ env: { SERVER__PROT: '9999', NOT_A_FIELD__X: '1' } });
    expect(config.server.port).toBe(defaultConfig().server.port);
    expect(Object.keys(config.server)).not.toContain('prot');
  });

  it('CLI 覆盖优先级高于环境变量', () => {
    const config = loadConfig({
      env: { SERVER__PORT: '1111' },
      overrides: { server: { port: 2222 } },
    });
    expect(config.server.port).toBe(2222);
  });

  it('12-factor 别名生效（PORT / DATABASE_URL）', () => {
    const config = loadConfig({ env: { PORT: '7000', DATABASE_URL: 'postgres://u:p@h:5432/d' } });
    expect(config.server.port).toBe(7000);
    expect(config.database.url).toBe('postgres://u:p@h:5432/d');
  });

  it('DSN 优先使用整串 url，否则按分项拼接', () => {
    const withUrl = loadConfig({ env: { DATABASE_URL: 'postgres://u:p@h:5432/d' } });
    expect(databaseDsn(withUrl.database)).toBe('postgres://u:p@h:5432/d');

    const parts = loadConfig({
      env: { DATABASE__HOST: 'h', DATABASE__NAME: 'd', DATABASE__USERNAME: 'u', DATABASE__PASSWORD: 'p' },
    });
    expect(databaseDsn(parts.database)).toContain('postgresql://u:p@h:5432/d');
  });

  it('多端口冲突会被拦截（同一个端口不能挂两个层）', () => {
    const config = defaultConfig();
    config.server.adminPort = config.server.port;
    expect(() => validateConfig(config)).toThrow(/conflict/i);
  });

  it('未知驱动不会生成一个错误的 DSN，而是直接报错', () => {
    const config = defaultConfig();
    // @ts-expect-error 故意传入非法驱动，验证运行时行为
    config.database.driver = 'oracle';
    expect(() => databaseDsn(config.database)).toThrow(/unsupported database driver/);
  });

  it('端口 0 表示关闭，是合法配置', () => {
    const config = defaultConfig();
    config.server.metricsPort = 0;
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('configInfo 脱敏：不泄漏数据库密码与密钥', () => {
    const config = defaultConfig();
    config.database.password = 'super-secret-password';
    config.security.sessionSecret = 'another-secret';
    const info = JSON.stringify(configInfo(config));
    expect(info).not.toContain('super-secret-password');
    expect(info).not.toContain('another-secret');
  });

  it('state.driver=etcd 必须提供 endpoints，否则启动就报错', () => {
    const config = defaultConfig();
    config.state.enabled = true;
    config.state.driver = 'etcd';
    expect(() => validateConfig(config)).toThrow(/etcd.*endpoints/i);

    config.state.endpoints = ['http://127.0.0.1:2379'];
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('生产环境禁止把验证码写进日志（captured logs = 可登录）', () => {
    const config = defaultConfig();
    config.environment = 'prod';
    config.verification.enabled = true;
    config.verification.exposeInLogs = true;
    expect(() => validateConfig(config)).toThrow(/expose_in_logs/i);

    config.verification.exposeInLogs = false;
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('分表默认关闭，但配置结构齐全（format/间隔/提前量）', () => {
    const sharding = defaultConfig().database.sharding;
    expect(sharding.enabled).toBe(false);
    expect(sharding.format).toBeTruthy();
    expect(sharding.checkIntervalMs).toBeGreaterThan(0);
    expect(sharding.prepareAdvanceMs).toBeGreaterThan(0);
  });
});

describe('环境变量优先级：别名必须确定性地胜出', () => {
  it('LOG_LEVEL 覆盖 .env 里的 LOGGING__LEVEL（不受 process.env 写入顺序影响）', () => {
    const a = loadConfig({
      env: { LOGGING__LEVEL: 'debug', LOG_LEVEL: 'silent' },
    });
    const b = loadConfig({
      env: { LOG_LEVEL: 'silent', LOGGING__LEVEL: 'debug' },
    });
    expect(a.logging.level).toBe('silent');
    expect(b.logging.level).toBe('silent');
  });

  it('冲突会变成可诊断的 warning，而不是静默选一个', () => {
    const loaded = loadConfigDetailed({
      env: { LOGGING__LEVEL: 'debug', LOG_LEVEL: 'silent' },
    });
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain('logging.level');
    expect(loaded.warnings[0]).toContain('LOG_LEVEL');
  });

  it('没有冲突时不产生噪声', () => {
    expect(loadConfigDetailed({ env: { LOG_LEVEL: 'warn' } }).warnings).toEqual([]);
  });

  it('通用形式仍然生效，且类型由默认值推断', () => {
    const config = loadConfig({
      env: {
        SERVER__PORT: '7777',
        SERVER__ADMIN_PORT: '7778',
        // snake_case 叶子也能识别：两种写法落到同一个 camelCase 字段
        SERVER__READ_TIMEOUT_MS: '9000',
      },
    });
    expect(config.server.port).toBe(7777);
    expect(config.server.adminPort).toBe(7778);
    expect(config.server.readTimeoutMs).toBe(9000);
  });
});

describe('环境变量拼错时必须出声', () => {
  it('无法识别的配置键不会被静默吞掉', () => {
    // 真实的坑：写 DATABASE__SSL（正确名是 SSL_MODE）时，
    // 旧实现静默忽略 → "我明明配了却不生效"，排查成本极高
    const loaded = loadConfigDetailed({
      env: { DATABASE__SSL: 'true', SECURITY__ALLOWED_ORIGIN: 'x' },
    });
    expect(loaded.warnings).toHaveLength(2);
    expect(loaded.warnings[0]).toContain('DATABASE__SSL');
    expect(loaded.warnings[1]).toContain('SECURITY__ALLOWED_ORIGIN');
  });

  it('正确拼写不产生警告', () => {
    const loaded = loadConfigDetailed({
      env: { DATABASE__SSL_MODE: 'require', SECURITY__ALLOWED_ORIGINS: 'https://a.example' },
    });
    expect(loaded.warnings).toEqual([]);
  });

  it('别名同样会被校验', () => {
    const loaded = loadConfigDetailed({ env: { PORT: '1234' } });
    expect(loaded.config.server.port).toBe(1234);
    expect(loaded.warnings).toEqual([]);
  });
});
