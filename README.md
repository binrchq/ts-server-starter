# ts-server-starter

地道 TypeScript 写的后端服务模板。多端口分层、运行时 DI、服务生命周期管理、
定时任务调度、可插拔基础设施驱动、SQL 迁移引擎、安全基线开箱可用。

它对应 Go 世界里 `go-starter` 那一类模板，但**不是逐行翻译**：
Node/TS 有自己的惯用法，照搬 Go 的 `context.Context`、`(val, cleanup, err)` 三元组、
编译期 Wire，只会得到一份能跑但难读的代码。映射关系见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#与-go-starter-的概念映射)。

## 特点

- **多端口分层**：`outer` / `admin` / `inner` / `openapi` / `metrics` 各自一个 Express 应用，
  中间件管线按层裁剪。隔离是部署级的（防火墙可分别控制），不是路径级的。
- **运行时 DI**：类型化 token 的容器，启动时 `warmup()` 主动实例化，装配错误在启动时报错而不是首次请求。
- **服务生命周期**：`AbstractService` + `ServiceManager`，启动顺序显式、失败自动回滚。
- **定时任务**：最小堆调度器，支持依赖、并发上限、前置条件、完成回调。
- **零多余依赖**：结构化日志、Prometheus 指标、JWT、密码哈希、id 生成全是自己写的（约 500 行），
  不为 20 行功能引入 pino / winston / prom-client / passport。
- **安全基线**：安全响应头、分层 CORS、分级限流、密钥启动自检、日志脱敏、审计事件、令牌受众校验。
- **可插拔基础设施**：数据库（pg / prisma / mysql / sqlite / mongodb）、缓存、消息队列、
  分布式状态（memory / redis / etcd）都是「接口 + 多驱动」，按配置切换。
- **动态分表**：`ShardRegistry` 描述逻辑表 → 物理分表（按年/月/日/时），`TablePreparerService`
  提前建表，避免首次写入时才发现分表不存在。
- **验证码**：`modules/verification` 提供发送/校验/一次性消费，哈希存储、冷却期、每日上限，
  默认写日志，生产注入短信/邮件发送器。
- **迁移引擎**：SQL 文件驱动，带 sha256 漂移检测与 `create` 骨架生成。
- **测试**：212 个用例，含真实 HTTP 端到端冒烟（临时端口，不依赖外部服务）。

## 快速开始

```bash
pnpm install
cp .env.example .env      # 至少填 SECURITY__SESSION_SECRET 与 SECURITY__INTERNAL_TOKEN

pnpm migrate up           # 需要可用的 Postgres；只跑单元测试不需要
pnpm dev                  # http://127.0.0.1:4600
```

不依赖数据库也能跑的部分：

```bash
pnpm verify               # 类型检查 + lint + 212 个测试
pnpm routes               # 打印完整路由矩阵（不需要连数据库）
```

## 目录结构

```
src/
  main.ts                 进程入口（唯一带 shebang 的文件）
  cli/                    commander 定义：serve / migrate / routes / version
  config/                 zod schema + defaultConfig + loader（默认值 ← yaml ← env ← CLI）
  app/                    HTTP 层：中间件、路由注册表、多端口服务、指标、路由分组
    routes/v1/            outer / admin / inner / openapi 四层路由器
  modules/                业务模块，一个模块 = service + controller + repository + index
  core/                   DI 容器、服务基类/管理器、请求上下文、定时任务
  infra/                  database / cache / messaging / state / redis / migrate
  security/               安全响应头、CORS、限流、脱敏、审计、密钥自检
  shared/                 日志、错误、加密、密码、校验、HTTP 响应助手
  serve/                  wire（装配）+ serve（启动与优雅退出）
  types/                  全局类型增强
tests/                    vitest：单元 + 集成
migrations/{postgres,mysql,sqlite}
docs/                     架构、安全、教程
skills/                   给 AI 编码助手看的操作手册
deploy/                   生产部署要点
```

分层依赖是单向的：`shared` ← `core`/`infra` ← `security` ← `modules` ← `app` ← `serve`。
`shared` 不允许 import 任何上层模块。

## 常用命令

```bash
pnpm dev             # tsx watch 热重载
pnpm build           # tsc 编译到 dist/ 并拷贝 config.yaml
pnpm start           # 运行编译产物
pnpm typecheck       # 源码 + 测试双 tsconfig 检查
pnpm lint            # ESLint（类型感知规则已开）
pnpm format          # Prettier
pnpm test            # vitest run
pnpm test:coverage   # 带覆盖率
pnpm verify          # 提交前自检
pnpm smoke           # 对已启动实例跑端到端冒烟
pnpm routes          # 路由矩阵（已带 --config）
pnpm info            # 版本与运行时信息（CLI 子命令名叫 version）
pnpm migrate up|down|status|create
```

`serve` / `migrate` / `routes` / `info` 都显式传 `--config ./src/config/config.yaml`。
不传也能跑，但那时只有默认值 + 环境变量 —— 端口、库名全走默认，很容易出现
「我明明在 yaml 里改了」。配置文件路径写错会**直接报错**，而不是静默退回默认值；
启动日志和 `/admin/info` 里的 `configFile` 就是实际读到的那份文件。

或者用 `make`：`make help` 列出全部目标。

## 配置

优先级：**默认值 ← `config.yaml` ← 环境变量 ← CLI 参数**（后者覆盖前者）。

环境变量用双下划线表示层级，叶子节点写 snake_case 或 camelCase 皆可：

```bash
SERVER__PORT=8080            # → server.port
SERVER__ADMIN_PORT=8081      # → server.adminPort
LOGGING__LEVEL=debug         # → logging.level
```

识别不了的路径会被**忽略，但会打 WARN**。两类问题在启动时就能看见：

```
WARN configuration warning detail=DATABASE__SSL matches no known setting and was ignored
WARN configuration warning detail=LOGGING__LEVEL and LOG_LEVEL both set logging.level; using LOG_LEVEL
```

值的类型由默认值的类型决定 —— 默认是 `number` 就按数字解析，默认是 `boolean` 就接受
`true/false/1/0/yes/no`。这样新增配置项不需要额外维护一份「哪些字段是数字」的清单。

常用别名（等价于完整路径）：`DATABASE_URL`、`REDIS_URL`、`SESSION_SECRET`、
`NODE_ENV`、`ENVIRONMENT`、`APP_NAME`、`APP_VERSION`、`PORT`、`LOG_LEVEL`、`LOG_FORMAT`。

**别名恒胜**：`LOG_LEVEL` 与 `LOGGING__LEVEL` 指向同一个配置项时，永远以别名（`LOG_LEVEL`）为准，
并打上面那条 WARN。这一点是刻意固定的 —— 否则谁生效取决于变量写进 `process.env` 的先后
（shell 变量在前、`dotenv` 加在后），会出现「我明明设了 `LOG_LEVEL=silent` 却还是 DEBUG 日志」
这种查不出原因的问题。

完整可配置项见 [`src/config/config.yaml`](src/config/config.yaml) 与
[`.env.example`](.env.example)。

启动时可诊断项（排查「配置没生效」先看这两处）：

```
configFile=/abs/path/to/config.yaml          # 实际读到的是哪一份文件
ai={"endpoints":["openai=https://.../v1"]}   # 实际生效的地址（脱敏，无密钥）
```

`docker-compose*.yml` 与 `.env.example` 里的键名由测试守着（`tests/deploy-config.test.ts`）：
写错的键不会让部署失败，只会打一条 WARN —— 真实案例是把 `server.trust_proxy`
写成 `SECURITY__TRUST_PROXY`，结果限流按前置 LB 的 IP 统计。

## 五个端口

| 端口 | 层 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| 4600 | outer | 可选（Bearer JWT） | 业务接口 `/api/v1/*` |
| 4601 | admin | 必须 admin 角色 | 后台 `/admin/*` |
| 4602 | inner | `X-Internal-Token` | 服务间调用 `/internal/*` |
| 4603 | openapi | `X-Api-Key` | 开放平台 `/openapi/v1/*`，CORS 为 `*` 且 `credentials:false` |
| 4604 | metrics | 无（靠网络隔离） | `/metrics` |

把端口设为 `0` 可关闭对应监听。详见 [`deploy/README.md`](deploy/README.md)。

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 分层、DI、请求生命周期、与 go-starter 的映射
- [`docs/SECURITY.md`](docs/SECURITY.md) —— 威胁模型与安全审计清单
- [`docs/TUTORIAL.md`](docs/TUTORIAL.md) —— 从零加一个业务模块
- [`SECURITY.md`](SECURITY.md) —— 漏洞上报流程与支持版本
- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 提交规范
- [`ROUTERS.md`](ROUTERS.md) —— 由 `pnpm routes` 生成的路由矩阵

## 与 go-starter 的取舍

| go-starter | 本模板 | 原因 |
| --- | --- | --- |
| Wire 编译期注入 | 运行时容器 + 启动预热 | TS 没有编译期 DI；用 `warmup()` 把错误提前到启动 |
| `context.Context` | `AsyncLocalStorage` + `AbortSignal` | Node 里 ALS 才能跨 await 透传，且不污染每个函数签名 |
| `(val, cleanup, error)` | `Promise<T>` + `close()` / `Symbol.asyncDispose` | `await using` 是 TS 的原生资源管理 |
| `gin.H` / `c.JSON` | 类型化 `ok()` / `fail()` | 响应体结构在类型里表达，而不是 `map[string]any` |
| `zerolog` | 手写结构化 logger | 需求只有「JSON + 分级 + 脱敏」，引入依赖不划算 |
| `viper` | `yaml` + `zod` + 自定义 loader | zod 顺便做校验和类型推导，一举两得 |
| `errors.Is/As` | `AppError` + `code` 字段 | 错误码要能安全地透给前端，`instanceof` 不够 |
| `preparer/database` 提前建分表 | `ShardRegistry` + `TablePreparerService` | 同思路；TS 把纯逻辑与轮询循环拆开，时钟可注入、易测 |
| `preparer/state/etcd`（Lock 未实现） | `EtcdState`（CAS / 租约 / increment） | 对齐接口并补齐了参考实现里留空的锁语义 |
| 短信/验证码服务 | `modules/verification` | 复用 `StateAdapter` 存储，哈希 + 一次性消费 + 频控 |

## License

MIT
