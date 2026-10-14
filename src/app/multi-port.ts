/**
 * 多端口 HTTP 服务（对应 go-starter 的多端口路由）。
 *
 * 为什么分端口而不是靠路径前缀：
 *   隔离是「部署级」的 —— 内网端口可以在安全组/Service 层面只对内网开放，
 *   即使应用层鉴权写错，攻击面也不会暴露到公网。路径前缀做不到这一点。
 *
 * 每个端口一个独立 Express 实例，中间件管线按层裁剪：
 *   outer    json body + cookie + CORS(白名单, credentials)
 *   admin    json body + cookie + CORS(白名单) + 依赖 admin 角色
 *   inner    不解析 body 之外的东西，只认共享密钥头
 *   openapi  json body，无 cookie（credentials=false）
 *   metrics  纯文本输出，不解析 body、不限流（否则抓取会被自己限流）
 */
import http from 'node:http';
import type { Socket } from 'node:net';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import type { AppContext } from './context.js';
import type { RedisHandle } from '../infra/redis/client.js';
import { AbstractService } from '../core/service.js';
import type { ServiceContext } from '../core/context.js';
import type { HeaderProfile } from '../security/headers.js';
import type { RouterLayer } from '../security/cors.js';
import { errorHandler, notFoundHandler, requestContext, requestId, requestLogger } from './middleware/index.js';
import { createDefaultMetrics, createMetricsHandler, type MetricRegistry } from './metrics.js';

export interface HttpChannel {
  /** 路由层名，用于日志与 CORS 策略 */
  layer: RouterLayer;
  /** 端口；0 表示该端口未启用 */
  port: number;
  host?: string;
  profile?: HeaderProfile;
  /** 是否解析请求体（metrics 端口不需要） */
  parseBody?: boolean;
  /** 是否启用全局限流（metrics 端口应关闭） */
  rateLimit?: boolean;
  /** 挂载路由 */
  mount(app: Express, ctx: AppContext): void;
}

export interface HttpServiceOptions {
  ctx: AppContext;
  channels: HttpChannel[];
  /** 优雅关闭时等待在途请求的时间，默认 10s */
  gracefulShutdownMs?: number;
}

interface ListeningServer {
  layer: string;
  port: number;
  server: http.Server;
  sockets: Set<Socket>;
}

export class HttpService extends AbstractService {
  readonly name = 'http';
  readonly metrics: MetricRegistry;

  private readonly servers: ListeningServer[] = [];
  private readonly options: HttpServiceOptions;

  constructor(options: HttpServiceOptions) {
    super();
    this.options = options;
    this.metrics = createDefaultMetrics(options.ctx);
  }

  /** 供集成测试直接拿 app（不监听端口） */
  createApp(channel: HttpChannel): Express {
    return this.buildApp(channel);
  }

  protected async onStart(ctx: ServiceContext): Promise<void> {
    const { ctx: appCtx, channels } = this.options;

    for (const channel of channels) {
      if (!channel.port) continue;
      if (this.servers.some((s) => s.port === channel.port)) {
        throw new Error(`http channel "${channel.layer}" reuses port ${channel.port}`);
      }

      const app = this.buildApp(channel);
      const host = channel.host ?? appCtx.config.server.host;
      const server = http.createServer(app);

      // 超时必须设置，否则慢连接会一直占着 socket（Slowloris 攻击面）
      server.headersTimeout = appCtx.config.server.readTimeoutMs;
      server.requestTimeout = appCtx.config.server.writeTimeoutMs;
      server.keepAliveTimeout = 65_000;
      server.maxRequestsPerSocket = 1000;

      const entry: ListeningServer = { layer: channel.layer, port: channel.port, server, sockets: new Set() };
      // 记录活跃连接，关闭时才能「先优雅、后强制」
      server.on('connection', (socket) => {
        entry.sockets.add(socket);
        socket.on('close', () => entry.sockets.delete(socket));
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`port ${channel.port} (${channel.layer}) is already in use`));
          } else {
            reject(err);
          }
        };
        server.once('error', onError);
        server.listen(channel.port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });

      this.servers.push(entry);
      ctx.logger.info('http channel listening', {
        layer: channel.layer,
        host,
        port: channel.port,
        url: `http://${host}:${channel.port}`,
      });
    }

    if (this.servers.length === 0) ctx.logger.warn('no http channel enabled');
  }

  protected async onStop(ctx: ServiceContext): Promise<void> {
    const deadline = Date.now() + (this.options.gracefulShutdownMs ?? 10_000);

    await Promise.all(
      this.servers.map(
        (entry) =>
          new Promise<void>((resolve) => {
            ctx.logger.debug('closing http channel', { layer: entry.layer, port: entry.port });
            // 先停止接受新连接与空闲连接，再等在途请求自然结束
            entry.server.closeIdleConnections?.();
            entry.server.close(() => resolve());

            const interval = setInterval(() => {
              if (Date.now() >= deadline) {
                clearInterval(interval);
                // 超时后强制断开剩余连接（否则进程可能永久挂住）
                for (const socket of entry.sockets) socket.destroy();
                resolve();
              }
            }, 250);
            interval.unref?.();
          }),
      ),
    );

    this.servers.length = 0;
  }

  /** 已监听端口，供 admin/inner 的自查接口使用 */
  listeningPorts(): Array<{ layer: string; port: number }> {
    return this.servers.map(({ layer, port }) => ({ layer, port }));
  }

  private buildApp(channel: HttpChannel): Express {
    const ctx = this.options.ctx;
    const { config } = ctx;
    const app: Express = express();

    app.disable('x-powered-by');
    // trust proxy 必须显式配置：默认为 false 时限流按 socket IP 统计，
    // 设成 true 则任何客户端都能通过伪造 X-Forwarded-For 绕过限流。
    app.set('trust proxy', config.server.trustProxy);
    app.set('etag', false);

    // ── 可观测性（最先挂：保证失败的请求也有 requestId 与访问日志）
    app.use(requestId());
    app.use(requestContext(ctx.logger, channel.layer));
    app.use(
      requestLogger({
        logger: ctx.logger,
        redact: ctx.security.redact,
        ignorePaths: channel.layer === 'metrics' ? ['/'] : ['/health', '/livez', '/readyz', '/metrics'],
      }),
    );

    // ── 安全
    for (const middleware of ctx.security.forLayer(channel.layer, channel.profile ?? 'api')) {
      app.use(middleware);
    }

    // ── 限流（metrics 端口除外：抓取不该被限流）
    if (channel.rateLimit !== false) app.use(ctx.security.limiters.global);

    // ── 解析（metrics 端口不解析 body，减少解析开销与攻击面）
    if (channel.parseBody !== false) {
      app.use(express.json({ limit: config.server.bodyLimit, strict: true }));
      // urlencoded 默认关闭：纯 JSON API 暴露表单解析没有必要
      app.disable('x-powered-by');
      app.use(cookieParser());
    }

    // SSE 不能被压缩（会破坏流式刷新），因此按 content-type 过滤
    app.use(
      compression({
        filter: (req, res) => {
          if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) return false;
          return compression.filter(req, res);
        },
      }),
    );

    if (channel.layer === 'metrics') {
      app.get('/', createMetricsHandler(this.metrics));
      app.get('/metrics', createMetricsHandler(this.metrics));
    }

    channel.mount(app, ctx);

    app.use(notFoundHandler());
    app.use(
      errorHandler({
        logger: ctx.logger,
        redact: ctx.security.redact,
        // 仅开发环境回传内部细节，生产环境只给 requestId
        includeDetails: config.environment !== 'prod',
      }),
    );

    return app;
  }
}

/** 常用中间件：把一个 Promise 化 handler 挂到裸 Express app 上 */
export function useAsync(
  app: Express,
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): void {
  app.use((req, res, next) => {
    void handler(req, res, next).catch(next);
  });
}

export type { RedisHandle };
