# Route Matrix

> 由 `RouteRegistry.toMarkdown()` 生成，请勿手工维护。

## outer

| Method | Path | Access | Rate limit | Validation | Description |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/auth/logout` | user | global | - | 无状态令牌：客户端丢弃即可 |
| GET | `/api/v1/auth/me` | user | global | - | 当前登录用户 |
| GET | `/api/v1/health` | public | global | - | 完整健康报告（含依赖） |
| GET | `/api/v1/keys` | user | global | - | 我的 API Key 列表 |
| POST | `/api/v1/keys` | user | global | yes | 创建 API Key（明文仅返回一次） |
| DELETE | `/api/v1/keys/:id` | user | global | yes | 撤销 API Key |
| GET | `/api/v1/livez` | public | global | - | 存活探针（不查依赖） |
| POST | `/api/v1/public/auth/login` | public | auth | yes | 账号密码登录（限流抗撞库） |
| POST | `/api/v1/public/auth/refresh` | public | auth | yes | 刷新 access token |
| POST | `/api/v1/public/auth/register` | public | auth | yes | 注册并直接签发令牌 |
| GET | `/api/v1/public/ping` | public | global | - | 连通性探测 |
| GET | `/api/v1/readyz` | public | global | - | 就绪探针 |
| GET | `/api/v1/tasks` | user | global | yes | 任务列表 |
| POST | `/api/v1/tasks` | user | global | yes | 创建任务 |
| GET | `/api/v1/tasks/:id` | user | global | yes | 任务详情 |
| PATCH | `/api/v1/tasks/:id` | user | global | yes | 更新任务 |
| DELETE | `/api/v1/tasks/:id` | user | global | yes | 删除任务 |
| GET | `/api/v1/tasks/stats` | user | global | - | 任务统计（缓存 30s） |
| GET | `/api/v1/user/profile` | user | global | - | 我的资料 |
| PATCH | `/api/v1/user/profile` | user | global | yes | 更新我的资料 |

## admin

| Method | Path | Access | Rate limit | Validation | Description |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/audit/tail` | admin | global | yes | 审计日志检索（按时间倒序，可按 action/user/outcome 过滤） |
| GET | `/admin/health` | admin | global | - | 完整健康报告（含依赖） |
| GET | `/admin/info` | admin | global | - | 运行配置摘要（已脱敏） |
| GET | `/admin/livez` | admin | global | - | 存活探针（不查依赖） |
| GET | `/admin/readyz` | admin | global | - | 就绪探针 |
| GET | `/admin/users` | admin | global | yes | 用户列表 |
| GET | `/admin/users/:id` | admin | global | yes | 用户详情 |

## inner

| Method | Path | Access | Rate limit | Validation | Description |
| --- | --- | --- | --- | --- | --- |
| GET | `/internal/health` | internal | global | - | 完整健康报告（含依赖） |
| GET | `/internal/livez` | internal | global | - | 存活探针（不查依赖） |
| GET | `/internal/readyz` | internal | global | - | 就绪探针 |
| GET | `/internal/routes` | internal | global | - | 路由矩阵（供线上自查） |
| GET | `/internal/status` | internal | global | - | 服务与定时任务状态 |

## openapi

| Method | Path | Access | Rate limit | Validation | Description |
| --- | --- | --- | --- | --- | --- |
| GET | `/openapi/v1/ping` | user | global | - | 连通性探测（仍需 API Key） |
| GET | `/openapi/v1/whoami` | user | global | - | 当前 API Key 的身份与权限域 |
