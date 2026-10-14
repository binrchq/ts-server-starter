# Skill: 加/改控制器

## 形状

```ts
export interface FooController {
  create(req: Request, res: Response): Promise<void>;
}

export function createFooController(service: FooService): FooController {
  return {
    async create(req, res) {
      // 入参已由路由层校验，这里只需断言类型
      const body = req.body as CreateFooBody;
      created(res, await service.create(requirePrincipal(req).userId, body));
    },
  };
}
```

工厂函数而不是 class：没有状态、没有继承、不用 `this` 绑定。

## 硬性约束

1. **不要在控制器里 try/catch**。handler 由 `asyncHandler` 包了，
   rejection 会进 `errorHandler`。自己 catch 会把 `AppError` 降级成 500。
2. **不要漏 `await`**。`no-floating-promises` 会拦，但更该记住原因：
   漏了 await 请求会先返回、错误随后变成 unhandledRejection。
3. **只用 `ok` / `created` / `paginated` / `noContent` 写响应**，不要手写 `res.json`。
   统一封装负责 `requestId` 和响应形状一致。
4. **身份从 `requirePrincipal(req)` 取**，不要解析 `req.headers.authorization`。
5. **不要在这里做权限判断**（"是不是本人"属于服务层的业务规则；
   "是不是 admin"用路由的 `access`）。
6. 控制器里出现的类型都从 schema 文件 import，不要就地 `as any`。

## 分页

```ts
paginated(res, await service.list(userId, query));   // service 返回 { items, total }
```

`limit` / `offset` 的边界由 zod 保证；控制器不要自己再 clamp 一遍。

## 自检

- [ ] 没有 try/catch
- [ ] 没有裸 `res.json`
- [ ] 没有业务判断分支（`if (order.userId !== userId)` 属于 service）
- [ ] 每个 handler 返回 `Promise<void>`
