# 架构

## 全景

```
                    ┌──────────── serve/wire.ts ────────────┐
                    │ 加载配置 → 校验 → 建基础设施 → 装配容器 │
                    └───────────────────┬───────────────────┘
                                        │
   ┌────────────────┬───────────────────┼────────────────┬────────────────┐
   ▼                ▼                   ▼                ▼                ▼
outer:4600     admin:4601         inner:4602      openapi:4603     metrics:4604
   │                │                   │                │                │
   └────────────────┴───── app/multi-port.ts ────────────┴────────────────┘
                                每个端口一个独立 Express app
                                        │
                          modules/{auth,user,task,api-key,health}
                                        │
                    core（DI / 服务 / 上下文 / 定时器）+ infra（DB / 缓存 / MQ / 状态）
                                        │
                    security（头 / CORS / 限流 / 脱敏 / 审计 / 密钥自检）
                                        │
                              shared（日志 / 错误 / 加密 / 校验）
```

依赖是单向的。`shared` 是最底层，不允许反向 import。

## 请求生命周期

以 `POST /api/v1/tasks`（带 Bearer token）为例：

1. `requestId()` —— 读取或生成 `X-Request-Id`，回写到响应头。后续所有日志、
   所有错误响应都带这个 id，是排查线上问题的第一抓手。
2. `requestContext` —— 把 `{ requestId, method, path, startedAt }` 放进
   `AsyncLocalStorage`。**没有 `context.Context` 参数**，下游任何位置
   `getRequestContext()` 都能拿到。
3. `requestLogger` —— 打访问日志；`/health`、`/livez`、`/readyz`、`/metrics`
   被排除，否则探针会把日志淹掉。
4. `security.forLayer('outer')` —— helmet 安全头 + CORS + 该层的限流器。
5. `authenticate` —— 解析 `Authorization: Bearer`，校验签名与 `aud: 'access'`，
   成功后 `setCurrentUserId(userId)`（同样写进 ALS）。
6. `authorize('user')` —— 检查访问级别。
7. 控制器 → 服务 → 仓储。控制器只做「解析入参 + 调用服务 + 写响应」。
8. 成功：`ok(res, data)` 输出 `{ data, requestId }`。
   失败：`fail(res, error)` 输出 `{ error: { code, message, requestId, ... } }`。
9. `errorHandler` —— 兜底。连续两次 `next(err)` 会导致连接悬挂，所以这里检查
   `res.headersSent`；未预期错误的堆栈只写日志，对外统一 `Internal server error.`。

## 为什么是多端口而不是路径前缀

路径前缀（`/internal/*`、`/admin/*`）的隔离依赖反向代理规则正确。规则写错一次，
内部接口就上了公网。多端口把这层保障交给防火墙/安全组，并且每层可以有**不同的
中间件管线**：

| 层 | body 解析 | CORS | 限流档位 |
| --- | --- | --- | --- |
| outer | ✅ 64kb | 来源白名单 | global / auth / strict |
| admin | ✅ 64kb | 来源白名单 | 更严 |
| inner | ✅ 512kb | ❌ 不适用 | 独立 |
| openapi | ✅ 256kb | `*`（`credentials:false`） | 按 API Key |
| metrics | ❌ | ❌ | 无 |

`metrics` 层不解析 body 是刻意的：少一个攻击面（大 body 攻击）且省内存。

## 服务生命周期

```ts
class MyService extends AbstractService {
  readonly name = 'my-service';
  protected async onStart(): Promise<void> { /* 建连接、预热缓存 */ }
  protected async onStop(): Promise<void> { /* 逆序释放 */ }
}
```

`ServiceManager.startAll()` 按注册顺序启动，**任一步失败则逆序回滚已启动的服务**。
`stopAll()` 逆序停止（后依赖者先停）。这个行为有测试覆盖
（`tests/observability.test.ts`）。

## 依赖注入

```ts
const TokenA = createToken<ServiceA>('ServiceA', { name: 'ServiceA' });

container.register(TokenA, (c) => new ServiceA(c.get(ConfigToken)));
const a = container.resolve(TokenA);   // 懒创建 + 单例缓存
```

- `register(token, factory)`：懒创建。工厂抛错时**不缓存**，下次调用会重试。
- `resolve()` / `get()`：同步取出（必要时触发创建）。区分是因为异步工厂需要
  `await warmup()` 先行实例化。
- `warmup()`：启动时把关键依赖全部实例化。**装配错误必须在启动时报错**，
  而不是等第一个请求进来才 500。
- 循环依赖会被检测并明确报错（`circular dependency detected at "X"`），
  而不是栈溢出。
- `dispose()` 之后任何访问都会报 `container has been disposed`，而不是
  含糊的「依赖未注册」。

### 为什么不用装饰器/reflect-metadata

装饰器方案要求 `emitDecoratorMetadata` + `reflect-metadata`，编译产物变重、
类型信息在运行时会丢失进程间边界。显式 token + 工厂函数让装配过程可读、
可断点、可在测试里替换（见下）。

### 测试接缝

`wire({ infrastructure: { database, cache, mq, state } })` 可以整体替换基础设施。
集成测试因此不需要真实 Postgres/Redis，跑得又快又稳。
`close()` 只释放自己创建的资源（`owned` 标记），外部注入的不动。

## 错误处理

`AppError` 带 `code` / `statusCode` / `expose`：

- `expose: true`（如 `VALIDATION_ERROR`）：消息可以安全地给前端看
- `expose: false`（如数据库报错）：对外统一 `Internal server error.`，细节只进日志

错误码是稳定契约：新增错误类型时先想清楚前端要怎么处理，再决定 code。
`requestId` 会自动带进每个错误响应，用户截图就能定位。

## 定时任务

```ts
timerWheel.schedule({
  id: 'cleanup-expired-tokens',
  intervalMs: 60_000,
  handler: async () => { ... },
  dependencies: ['db-ready'],       // 依赖未完成时跳过本轮
  maxConcurrent: 1,                 // 并发上限（信号量）
  timeoutMs: 30_000,
  precondition: () => container.has(TokenDb),
  onCompleted: (result) => metrics.counter('job_done').inc(),
});
```

实现是最小堆（不是 Go 版里的哈希时间轮）—— 任务数量在几百量级时，最小堆的
O(log n) 插入/取出完全够用，而且 `nextRun` 语义直接、调试友好。

## 分表与验证码

### 动态分表

`ShardRegistry`（`src/infra/database/sharding.ts`）把「逻辑表 + 时间粒度」映射到物理表名：

```ts
const registry = new ShardRegistry([
  { table: 'audit_log', period: 'month', baseTable: 'audit_log' },
]);
registry.resolve('audit_log', new Date('2026-02-14')); // "audit_log_202602"
```

`TablePreparerService` 是常驻服务，按 `database.sharding.checkIntervalMs` 轮询，在
`prepareAdvanceMs` 之前就把下一个周期的分表建好（`CREATE TABLE ... LIKE base`）。
纯逻辑 `TablePreparer` 与轮询服务分开：前者时钟可注入（`now`），因此不需要真的等到月底就能测。

### 验证码

`modules/verification` 只依赖 `StateAdapter`（memory / redis / etcd 都能跑）：

- 存的是验证码的 **sha256**，不是明文；校验用 `timingSafeEqual`。
- 校验成功即**一次性消费**；连续错误达 `maxAttempts` 后作废。
- `cooldownMs` 用 `setIfAbsent` 抢占，挡住「点一次发一次」；`dailyLimit` 限制单日发送量。
- 响应体只回打码后的 target，绝不回验证码本身；`exposeInLogs` 在 production 下被禁止。

真实发送渠道通过 `wire({ verificationSender })` 注入，默认实现只写日志。

## 与 go-starter 的概念映射

| go-starter | 本模板 | 说明 |
| --- | --- | --- |
| `preparer.Interface` | `wire()` 返回 `WiredApplication` | 装配产物是一个值，不是全局单例 |
| `core.Service` | `AbstractService` | `onStart`/`onStop` 替代 `Start/Stop` |
| `ServiceManager` | `core/service-manager.ts` | 失败回滚语义一致 |
| `cmd/app` | `src/cli/` | commander 替代 cobra |
| `configs/config.go` | `src/config/schema.ts` | zod 同时做校验与类型推导 |
| `viper` | `src/config/loader.ts` | 自研，约 150 行，行为可测 |
| `core/serve` | `src/serve/` | `wire` 与 `serve` 分离 |
| `core/middleware` | `src/app/middleware/` | 中间件顺序在 `multi-port.ts` 里显式可见 |
| `pkg/timer` | `src/core/timer-wheel.ts` | |
| `pkg/database` 多驱动 | `src/infra/database/` | 同样的「接口 + 驱动」结构 |
| `wrapper.SetupCORS` | `src/security/cors.ts` | 生产环境 fail-closed |
| `errors.Is/As` | `AppError.code` | 错误码是跨进程契约 |
| `preparer/database` | `infra/database/{sharding,table-preparer}.ts` | 逻辑表 → 分表 + 提前建表 |
| `preparer/state/etcd` | `infra/state/etcd-state.ts` | 用 mod_revision 作 fencing token |
