# Skill: 新增业务模块

## 产出清单

```
src/modules/<name>/
  index.ts                create<Name>Module + mount / mountAdmin / registerTimers
  <name>.schema.ts        zod 入参校验 + 导出的类型
  <name>.repository.ts    接口 + 至少一个实现
  <name>.service.ts       业务规则
  <name>.controller.ts    取身份 → 调服务 → 写响应
tests/<name>.test.ts      单元 + 集成
migrations/postgres/<ts>_<name>.{up,down}.sql
```

外加三处装配改动：`src/app/routes/v1/types.ts`（`Modules` 加一行）、
`src/serve/wire.ts`（构造 + 注册定时任务）、两个 router（`mount` / `mountAdmin`）。

## 步骤

1. **建模**：先确定表结构和**查询方式**，索引照查询建（不是给每个字段都建）。
   `pnpm migrate create add_<name>` 生成文件，写 up/down。已提交的迁移不要改。
2. **schema**：查询串用 `z.coerce`；分页参数给 `.default()`；用 `z.infer` 导出类型给 service。
3. **repository**：先定接口，再写实现。SQL **一律用 `?`**（`bind()` 翻译方言）。
   值转换（BIGINT→number、JSON 字符串→对象）在这一层做完，别泄漏到 service。
4. **service**：所有业务规则在这里。越权/非法状态要写审计事件（`outcome: 'denied'`）。
5. **controller**：只做三件事 —— 取身份（`requirePrincipal`）、调服务、写响应
   （`ok` / `created` / `paginated`）。**不要在这里写业务判断**。
6. **index.ts**：导出 `create<Name>Module(options)`，暴露 `service` / `controller` /
   `mount` / `mountAdmin` / `registerTimers`。
7. **装配 + 测试**：见 [`../../docs/TUTORIAL.md`](../docs/TUTORIAL.md) 第 7、8 节。

## 硬性约束

- 服务**不能** import `express`；控制器**不能** import 仓储实现
- 仓储接口**不能**暴露驱动专属类型（`PgQueryResult` 之类）
- 每个写接口声明 `access`，至少是 `user`
- 有状态机的地方，状态流转集中在一个方法里，不要散落在多个 controller 分支
- 分页一律返回 `{ items, total }` 走 `paginated()`，不要各写各的形状

## 自检

- [ ] `pnpm migrate status` 无 `drifted` / 无 `pending`
- [ ] `pnpm routes` 里能看到新路由，`access` 与预期一致
- [ ] 越权、非法状态、限流都有审计事件
- [ ] 至少一个"不该成功"的测试用例，而不只是 happy path
- [ ] `pnpm verify` 全绿
