# 安全设计与审计清单

本文回答两个问题：**模板默认防住了什么**、**上线前你必须自己确认什么**。
第二类更重要 —— 没有任何模板能替你决定「你的业务允许多少次登录失败」。

---

## 1. 信任边界

```
   公网/不可信                  ┌─────────────┐              可信内网
 ──────────────────────────────▶│  outer:4600 │──┐
                                └─────────────┘  │
   VPN / 跳板机                 ┌─────────────┐  │        ┌──────────────┐
 ──────────────────────────────▶│  admin:4601 │──┼───────▶│  Postgres    │
                                └─────────────┘  │        │  Redis       │
   不可信（第三方开发者）         ┌─────────────┐  │        └──────────────┘
 ──────────────────────────────▶│openapi:4603 │──┤
                                └─────────────┘  │
   只允许集群内                  ┌─────────────┐  │
 ──────────────────────────────▶│  inner:4602 │──┤
                                └─────────────┘  │
   只允许监控系统                ┌─────────────┐  │
 ──────────────────────────────▶│metrics:4604 │──┘
                                └─────────────┘
```

**关键假设**：`admin` / `inner` / `metrics` 三个端口在网络上不可从公网直达。
这三个端口没有设计成"能扛公网攻击"的样子 —— `metrics` 甚至不带认证。
如果你做不到网络隔离，就必须给它们加认证层，否则不要开这三个端口。

---

## 2. 威胁模型

| 威胁 | 缓解措施 | 位置 |
| --- | --- | --- |
| 撞库 / 暴力破解 | `auth` 档位限流（默认 10 次/分钟，按 IP+账号）、失败写审计 | `security/rate-limit.ts`、`modules/auth` |
| 账号枚举 | 「用户不存在」与「密码错误」返回完全相同的 401 文案；用户不存在时也跑一次哈希抹平时间差 | `modules/auth/auth.service.ts` |
| 时间侧信道 | 同上；密码校验统一走 scrypt（恒定开销） | `shared/password.ts` |
| 令牌伪造 | HMAC-SHA256 签名；`timingSafeEqual` 比较；`aud` 区分 access/refresh | `modules/auth/token.ts` |
| refresh 令牌当 access 用 | 显式 `aud: 'access' \| 'refresh'`，受众不符直接拒绝 | 同上 |
| 越权访问 | 路由级 `access: public/user/admin/internal` + 角色/scope 校验，拒绝事件写审计 | `app/middleware/authorize.ts` |
| SQL 注入 | 全部参数化占位符；`bind()` 统一方言转换；仓储里不做字符串拼接 | `infra/database/sql.ts` |
| XSS / 点击劫持 | helmet：CSP、`X-Frame-Options`、`nosniff`、`Referrer-Policy` | `security/headers.ts` |
| CSRF | API 层不用 Cookie 认证（Bearer 头），CSP `default-src 'none'` | `security/headers.ts` |
| 跨站数据读取 | CORS 白名单；**生产环境白名单为空则全部拒绝**（fail-closed） | `security/cors.ts` |
| 凭据进日志 | `redact` 按字段名递归打码（password/token/cookie/...） | `security/redact.ts` |
| 令牌进日志/Referer | 只在 `Authorization` 头或 `x-api-key` 头接受凭据，**绝不接受查询参数** | `app/middleware/authenticate.ts` |
| 版本指纹 | 关闭 `X-Powered-By`；对外错误信息不含堆栈 | `app/multi-port.ts`、`app/middleware/error-handler.ts` |
| 内部接口暴露 | 独立端口 + `X-Internal-Token`；令牌为空时 **全部返回 503** | `app/middleware/authorize.ts` |
| 密钥硬编码上线 | `assertSecretsSafe` 在 `ENVIRONMENT=prod` 时直接拒绝启动 | `security/secrets.ts` |
| 开发旁路泄漏到生产 | `assertDevBypassAllowed` 在 prod + `DEV_AUTH_BYPASS=1` 时抛错拒绝启动 | `modules/auth/auth.service.ts` |
| 慢速攻击 / 连接耗尽 | `headersTimeout` / `requestTimeout` / `keepAliveTimeout` / `maxRequestsPerSocket` | `app/multi-port.ts` |
| 大 body 攻击 | 按层限制 body 大小（outer 64kb），`metrics` 层完全不解析 body | `app/multi-port.ts` |
| SSE 被缓冲导致超时 | `X-Accel-Buffering: no` + compression 跳过 `text/event-stream` | `app/multi-port.ts` |
| 审计缺失 | 失败/拒绝事件写 `audit_logs`，有界队列 + 丢弃计数 | `security/audit-sink.ts` |
| 迁移被篡改 | 每个迁移记 sha256，变更后 `migrate status` 报 `drifted` | `infra/migrate/migrator.ts` |
| 依赖漏洞 | CI 跑 `pnpm audit --audit-level=high` | `.github/workflows/ci.yml` |

---

## 3. 认证与授权

### 令牌

- 算法 HMAC-SHA256（对称）。**仅单服务集群适用**；多服务且互不信任时应换 RS256/EdDSA。
- `aud` 是安全边界，不是元数据：`access` 与 `refresh` 互相不能替代。
- refresh 令牌的 roles 为空数组 —— 它唯一的能力是换新令牌。
- access 默认 1h、refresh 默认 30d。缩短 access 的代价是更多刷新流量，按业务权衡。

### API Key（openapi 层）

- 只在 `x-api-key` 头接受；查询参数会被日志、Referer、浏览器历史记录泄漏。
- 库里只存 `sha256`，明文只在创建时返回一次。
- 权限用 scope 表达（`tasks:read` / `user:read` / `admin` / `*`），撤销是软删除（`revokedAt`）。
- openapi 层 CORS 为 `*` 且 `credentials: false` —— 密钥在头里传，不能用 Cookie 隐式身份。

### 开发旁路

`DEV_AUTH_BYPASS=1` 会让**所有未认证请求**都以 `DEV_USER_ID` 身份通过。
它只用于本地开发与集成测试，且：

- `assertDevBypassAllowed` 在 `ENVIRONMENT=prod` 时抛错，进程起不来
- 审计事件会带 `source: 'dev-bypass'`，便于在日志里一眼发现"这是绕过身份"
- 集成测试必须显式断言 bypass 语义，不能靠它"顺便通过"

---

## 4. 审计

审计事件落 `audit_logs` 表（`migrations/postgres/20260102000001_audit_logs.up.sql`），
同时进结构化日志。两者都要，因为用途不同：日志便于实时告警，表便于长期检索与合规举证。

### 关键性质

| 性质 | 实现 | 为什么重要 |
| --- | --- | --- |
| 不阻塞请求 | 有界内存队列 +          定时批量写 | 数据库抖动不该拖垮业务 |
| 不无限吃内存 | `auditQueueCapacity`（默认 1000） | 数据库长期故障时进程不能被 OOM |
| 丢弃可观测 | `stats.dropped` / `stats.failures` / `stats.lastError` | 静默丢事件 = 合规缺口 |
| 失败也记录 | `outcome: 'failure' \| 'denied'` | 攻击特征主要来自失败样本 |
| 优雅退出不丢 | `close()` 冲刷，且只记日志不阻断关停 | 最后一批往往正是崩溃前的现场 |
| 主体不受限 | `user_id VARCHAR(64)`，不是 UUID | 开发旁路/服务账号也要能审计 |

### 已埋点的动作

`auth.login` `auth.registered` `auth.failed` `auth.refresh` `auth.logout`
`access.denied` `rate.limited` `api_key.created` `api_key.revoked`
`secret.accessed` `admin.action`

### 上线前必须做的三件事

1. **访问控制**：`audit_logs` 含邮箱等 PII。只有审计员/安全角色可读，
   不要和其它业务表共用一个数据库账号的读权限。
2. **保留期限**：确定保留多久（等保 6 个月起，行业合规可能更长），
   然后按时间分区或定期归档，不要让它无限增长拖慢 `ORDER BY created_at DESC`。
3. **告警接进来**：`stats.dropped > 0`、`outcome='denied'` 突增、
   同一邮箱 `auth.failed` 高频 —— 这三条是最该接告警的信号。

---

## 5. 密钥管理

| 变量 | 要求 | 缺失后果 |
| --- | --- | --- |
| `SECURITY__SESSION_SECRET` | ≥32 字符，高熵 | prod 拒绝启动；非 prod 打警告 |
| `SECURITY__INTERNAL_TOKEN` | ≥32 字符 | inner 端口全部 503（fail-closed） |
| `DATABASE__PASSWORD` | 生产用密钥管理服务注入 | — |

- 不要写进 `config.yaml`、镜像、Git。用 `_FILE` 挂载或密钥管理服务注入。
- 轮换 `SESSION_SECRET` 会立刻失效所有已签发令牌 —— 这正是它的作用，
  但也意味着不能"顺手换一下"，要有公告窗口。
- `.env` 已在 `.gitignore` 里；`.env.example` 只放占位符。

---

## 6. 上线前自检清单

**网络与暴露面**

- [ ] 只有 `outer`（必要时含 `openapi`）注册到公网入口
- [ ] `admin` / `inner` / `metrics` 仅内网可达，或已关闭（端口设为 `0`）
- [ ] TLS 在入口终止，且 `security.enable_hsts` 已打开
- [ ] `trust_proxy` 与真实拓扑一致（否则限流按错的 IP 统计 → 容易被绕过）

**鉴权与限流**

- [ ] `SECURITY__SESSION_SECRET` / `SECURITY__INTERNAL_TOKEN` 已由密钥管理注入
- [ ] `SECURITY__ALLOWED_ORIGINS` 只含真实前端域名（非空，否则浏览器侧全被拒）
- [ ] 限流档位按业务量校准；多副本部署时 `rateLimitStore` 换成 Redis
      （内存存储是**每副本独立**的，N 个副本等于把限额放大 N 倍）
- [ ] `DEV_AUTH_BYPASS` 未开启

**数据与审计**

- [ ] `audit_logs` 的访问控制与保留期限已确认
- [ ] 审计丢弃/拒绝突增已接告警
- [ ] 迁移由独立 job 执行，不是每个副本启动时跑
- [ ] 数据库账号遵循最小权限（业务账号不需要 DDL 权限，迁移账号单独一个）

**运维**

- [ ] `/metrics` 已接入监控，`http_requests_total` 与关键业务指标有面板
- [ ] liveness 用 `/api/v1/livez`、readiness 用 `/api/v1/readyz`，没有混用
- [ ] `terminationGracePeriodSeconds` > `server.gracefulShutdownMs`
- [ ] 容器非 root、根文件系统只读
- [ ] 依赖审计在 CI 里跑，高危直接挡合并

---

## 7. 已知取舍（不是疏漏）

1. **限流默认使用进程内内存存储**。单副本够用；多副本必须换 Redis，
   否则限额被副本数放大。代码留了 `rateLimitStore` 注入点。
2. **令牌用对称签名**。换来的是部署简单（不需要密钥分发），
   代价是任何持有密钥的服务都能签发令牌。
3. **登出是无状态的**：只记审计、不做服务端吊销。需要真吊销就上
   refresh token 白名单（Redis + `jti`）。
4. **审计队列满时丢弃最新事件**而不是阻塞请求。这个方向是刻意的：
   可用性优先，且丢弃量可观测。
5. **`audit_logs.user_id` 不是 UUID**。审计主体包括开发旁路、API Key、
   未来的服务账号，把 id 空间绑死在 UUID 上等于给自己留审计盲区。
6. **SQL 占位符转换是文本替换**（`infra/database/sql.ts`）。因此约定
   字符串字面量里不出现 `?`，Postgres 的 JSON `?` 运算符改用 `jsonb_exists()`。
7. **CSP 对 API 是 `default-src 'none'`**，对文档端口放宽。文档端口若不需要，
   直接设端口为 `0` 关掉。

---

## 8. 发现漏洞怎么办

见仓库根目录的 [`SECURITY.md`](../SECURITY.md)。请不要开公开 issue。
