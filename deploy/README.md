# 部署说明

## 端口与暴露面

模板默认监听 5 个端口。**这不是为了好看，而是一种安全边界**：
不同端口可以由防火墙/安全组独立控制，比在同一个端口上用路径前缀区分更可靠
（路径前缀一旦反代规则写错，内部接口就直接暴露到公网）。

| 端口 | 层 | 建议暴露范围 |
| --- | --- | --- |
| 4600 | `outer`（业务） | 公网 / 入口网关 |
| 4601 | `admin`（后台） | 仅内网或 VPN |
| 4602 | `inner`（内部） | 仅集群内，`X-Internal-Token` 二次校验 |
| 4603 | `openapi`（开放平台） | 公网，仅 API Key 鉴权，`credentials: false` |
| 4604 | `metrics` | 仅监控系统抓取，禁止公网 |

把不需要的端口设为 `0` 即可关闭对应的监听（例如单体后台服务只需 `outer`）。

## 迁移的执行时机

**不要**在每个副本启动时跑迁移。多副本滚动发布时：
- 同一时刻多个实例执行 DDL，可能互相阻塞甚至死锁
- 旧版本代码遇到新表结构，行为不可预期

推荐做法：发布流程里单独一个 job/init container 执行
`node dist/main.js migrate up`，成功后再滚动更新业务副本。
`docker-entrypoint.sh` 里的 `RUN_MIGRATIONS=true` 只适合单实例部署。

`SCHEMA_MIGRATIONS` 表会记录每个迁移的 sha256；文件被改动后再执行
`migrate status` 会报告 `drifted`，此时不要直接 `up`，先确认改动是否需要新迁移。

## 健康探针

| 端点 | 用途 | 是否查依赖 |
| --- | --- | --- |
| `/api/v1/livez` | liveness | 否（只证明进程没死） |
| `/api/v1/readyz` | readiness | 是 |

探针不要混用：liveness 查数据库的话，数据库抖动会让编排系统把所有副本杀掉，
把「依赖故障」放大成「服务全挂」。

## 密钥

生产必须显式提供，且不要放在镜像里：

- `SECURITY__SESSION_SECRET`（≥32 字符）—— 令牌签名密钥，泄漏等于任意用户可伪造
- `SECURITY__INTERNAL_TOKEN`（≥32 字符）—— 内部接口令牌，为空时 inner 端口返回 503
- `DATABASE__PASSWORD`

生产环境（`ENVIRONMENT=prod`）下 `assertSecretsSafe` 会在启动阶段直接抛错，
不会出现「带着默认密钥上线」的情况。

## Kubernetes 要点

- 用 `readinessProbe` 打 `/api/v1/readyz`，`livenessProbe` 打 `/api/v1/livez`
- 只把 `outer`（必要时加 `openapi`）注册到 Service；`admin`/`inner`/`metrics` 用单独的
  headless Service 或干脆不暴露
- `terminationGracePeriodSeconds` 要大于 `server.gracefulShutdownMs`（默认 10s），
  否则滚动更新会切断在途请求
- 容器以非 root 运行，只读根文件系统即可（日志默认输出 stdout）
