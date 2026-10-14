/**
 * 路由声明式封装（对应 go-starter 的 core/routers/wrapper）。
 *
 * Go 版是 `wrapper.Group(rg, "/public").GET(...).PUBLIC()` 这种链式标记。
 * 在 TS 里更自然的是「选项对象 + 分组」：
 *
 *   const api = group(router, ctx, '/api/v1/public')
 *   api.get('/health', healthController.check, { description: '健康检查' })
 *   api.post('/login', authController.login, { rateLimit: 'auth', schemas: { body: LoginSchema } })
 *
 * 权限、限流、校验都由 access/rateLimit/schemas 三个选项推导，
 * 不可能忘记挂（对比 Go 版：忘了调 .AUTH() 就会裸奔）。
 */
import { Router, type RequestHandler } from 'express';
import type { ValidationSchemas } from '../../shared/validation.js';
import { validate as validateMiddleware } from '../../shared/validation.js';
import { asyncHandler, type AsyncRouteHandler } from '../../shared/http/async-handler.js';
import type { RateLimiters } from '../../security/rate-limit.js';
import type { AccessLevel, RateLimitPolicy, RouteRecord, RouteRegistry } from './registry.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

export interface RouteOptions {
  /** 缺省继承分组默认值，最终兜底 public */
  access?: AccessLevel;
  /** 缺省继承分组默认值，最终兜底 global（global 已在 app 层统一应用，见下方说明） */
  rateLimit?: RateLimitPolicy;
  schemas?: ValidationSchemas;
  description?: string;
  /** public 路由也解析身份（不强制） */
  optionalAuth?: boolean;
  /** 该路由的额外中间件（谨慎使用，会绕过声明式的权限推导） */
  middleware?: RequestHandler[];
}

export interface RouteGuards {
  authenticate: RequestHandler;
  optionalAuthenticate: RequestHandler;
  requireRoles(roles: string[]): RequestHandler;
  requireScopes(scopes: string[]): RequestHandler;
  requireInternalToken: RequestHandler;
  limiters: RateLimiters;
}

export interface RouteGroupOptions extends RouteOptions {
  layer: string;
  registry: RouteRegistry;
}

export class RouteGroup {
  constructor(
    private readonly router: Router,
    private readonly guards: RouteGuards,
    private readonly options: RouteGroupOptions,
    readonly prefix: string,
  ) {}

  group(prefix: string, options: RouteOptions = {}): RouteGroup {
    return new RouteGroup(this.router, this.guards, { ...this.options, ...options }, joinPath(this.prefix, prefix));
  }

  get(path: string, handler: AsyncRouteHandler, options: RouteOptions = {}): this {
    return this.route('get', path, handler, options);
  }
  post(path: string, handler: AsyncRouteHandler, options: RouteOptions = {}): this {
    return this.route('post', path, handler, options);
  }
  put(path: string, handler: AsyncRouteHandler, options: RouteOptions = {}): this {
    return this.route('put', path, handler, options);
  }
  patch(path: string, handler: AsyncRouteHandler, options: RouteOptions = {}): this {
    return this.route('patch', path, handler, options);
  }
  delete(path: string, handler: AsyncRouteHandler, options: RouteOptions = {}): this {
    return this.route('delete', path, handler, options);
  }

  /** 用于挂载现成的子路由（例如 WebSocket 升级、第三方 SDK 的 router） */
  use(path: string, ...handlers: RequestHandler[]): this {
    this.router.use(joinPath(this.prefix, path), ...handlers);
    return this;
  }

  private route(method: HttpMethod, path: string, handler: AsyncRouteHandler, options: RouteOptions): this {
    const access = options.access ?? this.options.access ?? 'public';
    const rateLimit = options.rateLimit ?? this.options.rateLimit ?? 'global';
    const fullPath = joinPath(this.prefix, path);

    const chain: RequestHandler[] = [];

    // 1. 限流。global 已在 app 层统一应用（避免同一次请求被计两次），
    //    这里只补 auth / strict:* 这类额外的、更严格的口径。
    const extraLimiter = this.resolveExtraLimiter(rateLimit);
    if (extraLimiter) chain.push(extraLimiter);

    // 2. 认证 + 授权（先认证再校验入参：未认证的请求不该消耗校验开销）
    chain.push(...this.resolveAccess(access, options.optionalAuth));

    // 3. 入参校验
    if (options.schemas) chain.push(validateMiddleware(options.schemas));

    // 4. 额外中间件
    if (options.middleware) chain.push(...options.middleware);

    // 5. 业务处理（async 包装，保证 Promise 异常能进错误中间件）
    chain.push(asyncHandler(handler));

    this.router[method](fullPath, ...chain);

    this.options.registry.add({
      layer: this.options.layer,
      method,
      path: fullPath,
      access,
      rateLimit,
      description: options.description ?? '',
      hasValidation: options.schemas !== undefined,
    } satisfies RouteRecord);

    return this;
  }

  private resolveExtraLimiter(policy: RateLimitPolicy): RequestHandler | null {
    if (policy === 'auth') return this.guards.limiters.auth;
    if (policy.startsWith('strict:')) return this.guards.limiters.strict(policy.slice('strict:'.length));
    return null;
  }

  private resolveAccess(access: AccessLevel, optionalAuth?: boolean): RequestHandler[] {
    switch (access) {
      case 'user':
        return [this.guards.authenticate, this.guards.requireRoles(['user', 'admin'])];
      case 'admin':
        return [this.guards.authenticate, this.guards.requireRoles(['admin'])];
      case 'internal':
        return [this.guards.requireInternalToken];
      case 'public':
      default:
        return optionalAuth ? [this.guards.optionalAuthenticate] : [];
    }
  }
}

export interface CreateRouteGroupOptions {
  layer: string;
  prefix: string;
  registry: RouteRegistry;
  guards: RouteGuards;
  defaults?: RouteOptions;
}

export function createRouteGroup(options: CreateRouteGroupOptions): { router: Router; group: RouteGroup } {
  const router = Router();
  return {
    router,
    group: new RouteGroup(
      router,
      options.guards,
      {
        layer: options.layer,
        registry: options.registry,
        access: options.defaults?.access,
        rateLimit: options.defaults?.rateLimit,
        description: options.defaults?.description,
      },
      options.prefix,
    ),
  };
}

/** 拼接路径，保证带前导斜杠、不出现重复斜杠 */
export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return joined === '' ? '/' : `/${joined}`;
}
