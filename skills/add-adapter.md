# Skill: 新增基础设施驱动

适用：给数据库 / 缓存 / 消息队列 / 状态存储加一种后端实现。

## 契约

每种能力都有「接口 + 工厂 + 懒加载动态 import」三件套：

```
src/infra/database/types.ts        Database 接口（不要在这里 import 任何驱动）
src/infra/database/index.ts        createDatabase(config, logger) 按 driver 分派
src/infra/database/<name>.driver.ts 实现
src/infra/cache/index.ts           createCache(...)
src/infra/messaging/index.ts       createMessageQueue(...)
src/infra/state/index.ts           createStateStore(...)
```

新增驱动时：

1. 在 `types.ts` 对应的联合类型里加 `'<name>'`（例如
   `DatabaseDriver = 'postgres' | 'mysql' | ... | '<name>'`）
2. 在 config schema 的枚举里同步加上（**两处都要改**，否则配置校验会拦下）
3. 实现类：构造函数里**立即**校验配置，缺什么就抛什么，不要延迟到第一次查询
4. 在工厂里用 `await import('./<name>.driver.js')` **懒加载**：
   没选用这个驱动的部署不该被迫安装它的依赖
5. 如果它不支持某个能力，**抛 NotImplementedError**，不要静默返回空结果

## 为什么懒加载而不是顶层 import

顶层 import 会让 `pg`、`ioredis`、`mysql2`、`mongodb` 全部成为硬依赖 ——
一个只用 SQLite 的部署要装十几个用不到的包（体积 + 供应链攻击面）。
动态 import 的代价是首次使用多几毫秒。

## 能力协商

`Database` 上暴露两个如实描述能力的字段：

```ts
readonly driver: DatabaseDriver;
readonly dialect: 'sql' | 'document';   // document 驱动不支持 query()，用 native 句柄
```

上层据此在**构造时**就给出明确结论 —— 例如 `SqlAuditRepository` 在
`dialect !== 'sql'` 时直接抛 ``audit_logs requires a SQL database, got driver "mongodb"``，
而不是每次写入静默失败。

**静默降级是最糟的选择**：它让"功能没生效"和"数据本来就是空"无法区分，
后者会让运维在错误的结论上排查几个小时。

## 关键约定

- `Database.query` 只接受 `?` 占位符，方言转换在驱动内部完成（见 `sql.ts`）
- 必须支持优雅关闭：`close(): Promise<void>`，且可重复调用不报错
- 连接池要有 `connectionTimeoutMillis`，否则数据库宕机时请求会无限堆积
- **不要在驱动里打业务日志**，只记连接生命周期（连上、断开、重连）
- 健康检查：`ping()` 必须便宜，且失败要抛错而不是返回 `false`
  （返回值容易被上游忽略，抛错不会）

## 测试

用接口写一套**所有驱动都要过**的契约测试（`describe.each`），
再加驱动专属的边界用例。不要为每个驱动写一遍不同的断言，
那样测的是实现而不是契约。

## 自检

- [ ] 接口没被驱动专属类型污染
- [ ] 配置错误在构造时就抛，且错误信息包含驱动名
- [ ] 不支持的能力抛 `NotImplementedError`
- [ ] `close()` 可重复调用
- [ ] 契约测试覆盖：连接失败、并发查询、关闭后使用（应有明确错误）
