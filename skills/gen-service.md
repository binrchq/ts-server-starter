# Skill: 加/改服务层

## 形状

```ts
export interface FooServiceOptions {
  repository: FooRepository;
  cache: Cache;
  auditor: Auditor;
  logger: Logger;
}

export class FooService {
  constructor(private readonly options: FooServiceOptions) {}
  async doSomething(...): Promise<...> { /* ... */ }
}
```

**构造函数注入 + `options` 对象**：加依赖时不用改调用点的位置，也不用记住参数顺序。
全部依赖都是必需的（测试里传显式替身），不要用可选依赖来"方便"。

## 服务层的职责边界

| 属于服务层 | 不属于服务层 |
| --- | --- |
| 业务规则、状态机 | HTTP 状态码、`res.json` |
| 事务边界 | SQL 字符串（放仓储） |
| 缓存读写与失效 | 入参格式校验（放 zod） |
| 权限的业务含义（"只能看自己的"） | 令牌解析、角色提取（放中间件） |
| 发消息、写审计 | 日志的格式化 |

## 缓存

- key 必须包含所有影响结果的维度（尤其 `userId`）。少一个维度就是跨用户串数据。
- 用 `cache.remember(key, ttlSeconds, loader)`，不要手写 get/set/判空三连。
- **写路径要显式失效**，或者把 TTL 设得足够短并说明理由（写成注释）。
- 缓存是「可选的加速」，不是「唯一真相源」：缓存层挂了业务要能退化到直接查库。

## 审计

拒绝类分支（越权、非法状态、超限）必须记：

```ts
this.options.auditor.record({
  action: AuditAction.AccessDenied,
  outcome: 'denied',
  userId,
  resource: `foo:${id}`,
  detail: { reason: 'not the owner' },   // 别记密码/token/完整身份证号
});
```

`detail` 会落库且保留很久 —— 记之前问一句"这条数据一年后泄露了会怎样"。

## 并发与幂等

- 需要"只执行一次"的效果就落到数据库约束（唯一索引），不要靠"先查再写"
- 定时任务假设**可能重入**（多副本、上一次没跑完），要么幂等，要么加锁
- 事务里不要做网络调用（HTTP、发消息）；消息在事务提交后发

## 自检

- [ ] 每个 `catch` 要么处理要么让上层知道，没有空 `catch`
- [ ] 没有 `sleep` / `setTimeout` 等待（要等就轮询条件）
- [ ] 新依赖全部通过 `options` 注入，没有直接 `import` 具体实现类
- [ ] 拒绝类分支有审计事件
