# Skill: 加/改路由

## 形状

```ts
group.post('/foos', controller.create, {
  access: 'user',                       // public | user | admin | internal
  rateLimit: 'strict:write',            // global | auth | none | strict:<key>
  schemas: { body: createFooBodySchema },
  description: '创建 Foo',
});
```

权限、限流、校验全部由选项推导 —— 不可能"忘了挂鉴权"，因为默认值是
`access: 'public'` 且 `registry` 会记录每条路由的级别，`pnpm routes` 一眼可见。

## 三件必须想清楚的事

### 1. 访问级别

| 级别 | 含义 | 用在哪 |
| --- | --- | --- |
| `public` | 无认证 | 登录、注册、健康检查、公开数据 |
| `user` | 认证 + 角色 `user` 或 `admin` | 绝大多数业务接口 |
| `admin` | 认证 + 角色 `admin` | 运营后台，挂 **admin 端口** |
| `internal` | `X-Internal-Token` | 服务间调用，挂 **inner 端口**，公网不可达 |

`admin` 接口**不要**挂在 outer 端口上，即便带了角色校验 ——
多一层网络隔离就少一类"鉴权中间件被绕过"的风险。

### 2. 限流档位

- 默认 `global`，已在 app 层统一应用，路由上不用重复声明
- 登录/注册/改密码/发验证码：`auth`
- 写接口、昂贵查询、调第三方：`strict:<key>`（key 自己定，如 `strict:write`）

**写成裸 `'strict'` 编译不过**（类型是模板字面量联合），这是刻意的：
限流策略写错会让人以为"已经防了"，属最危险的一类笔误。

多副本部署时内存限流器是**每副本独立**的，N 个副本等于限额放大 N 倍，
必须把 `rateLimitStore` 换成 Redis。

### 3. 校验

```ts
schemas: { body, query, params }
```

校验失败由 `errorHandler` 统一转成 `400 VALIDATION_ERROR` + 字段级 `details`。
校验在认证之后执行（未认证请求不该消耗校验开销）。

## 参数获取的两个坑

- `req.query` 的值类型是 `string | string[] | ParsedQs`，**必须**经 zod 转换后再用
- 路由顺序即匹配顺序：`/foos/:id` 要放在 `/foos/summary` 之后，否则
  `summary` 会被当成 id（Express 按声明顺序匹配，不会"最具体优先"）

## 自检

- [ ] `pnpm routes` 输出里 access 级别正确
- [ ] 敏感接口在正确的端口（admin → 4601，internal → 4602）
- [ ] 写接口用了更严的限流档位
- [ ] 动态段路由排在静态段之后
