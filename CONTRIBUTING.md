# 贡献指南

## 环境

- Node ≥ 22.11（用到 `node:sqlite` 与 `Symbol.asyncDispose`）
- pnpm ≥ 9
- 可选：Postgres 16 / Redis 7（只跑单元测试不需要）

```bash
pnpm install
cp .env.example .env
pnpm verify        # 类型检查 + lint + 测试，提交前必须全绿
```

## 提交规范

[Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>
```

类型：`feat` `fix` `refactor` `perf` `test` `docs` `chore` `build` `ci` `revert`
范围：模块名或目录名，如 `auth`、`infra/database`、`security`、`docs`

正文里说明**为什么**改，而不是重复 diff 里的"改了什么"。
破坏性变更写 `BREAKING CHANGE:` 段落。

## 代码约定

### 通用

- `strict: true` 下编译通过是硬要求，不允许 `@ts-expect-error` 掩盖真实类型问题
  （确有必要时必须在同一行写明原因）
- 不引入新的运行时依赖前先想清楚：能不能用 100 行以内自己实现？
  模板的既定立场是"零多余依赖"，新增依赖需要在 PR 里说明理由
- 所有跨 `await` 的上下文用 `AsyncLocalStorage`，不要往每个函数签名里加 `ctx` 参数

### 分层

- 依赖单向：`shared` ← `core`/`infra` ← `security` ← `modules` ← `app` ← `serve`
- `shared` 不允许 import 任何上层模块
- 业务模块之间不要直接 import；需要协作就走 DI token 或消息队列

### 安全相关

- 所有 SQL 参数化。禁止模板字符串拼接用户输入
- 新接口必须声明 `access` 级别，并注册到路由注册表（`createRouteGroup` 自动做）
- 拒绝类逻辑（401/403/429）要写审计事件，见 `security/audit.ts`
- 新错误类型要有稳定的 `code`，并想清楚 `expose` 该是 `true` 还是 `false`
- 提交前跑一遍 `docs/SECURITY.md` 里的自检清单（与本次改动相关的部分）

### 测试

- 新增能力必须有测试；修 bug 必须先有一个能复现的失败用例
- **禁止 `sleep`**：要等条件就写 `waitFor(predicate, timeoutMs)`
- **测试替身必须诚实**：不支持的能力直接抛错，不要静默返回空结果
  （一个永远返回空集的假数据库会让断言变成假绿）
- 单测不依赖外部服务；需要真实依赖的用例放集成测试，并在 CI 里提供服务容器
- 计时相关用小的 `intervalMs` + 轮询，不要靠固定等待

### 注释

- 注释回答"为什么这么做/为什么不那么做"，而不是复述代码
- 反直觉的选择、踩过的坑、被否决的替代方案 —— 这些最值得写下来
- 公开导出的类型与函数写 TSDoc

## 文件组织

新增业务模块时：

```
src/modules/<name>/
  index.ts             导出 create<Name>Module；mount / mountAdmin
  <name>.service.ts    业务逻辑
  <name>.controller.ts 只做入参解析 + 调用服务 + 写响应
  <name>.repository.ts 数据访问（接口 + 实现分离）
  <name>.schema.ts     zod 入参校验
```

细节见 [`docs/TUTORIAL.md`](docs/TUTORIAL.md)，也可以看 `skills/gen-module.md`。

## PR 流程

1. 从 `main` 开分支：`feat/xxx`、`fix/xxx`
2. `pnpm verify` 全绿
3. 涉及行为的改动更新文档（`docs/`、`README.md`、必要时 `ROUTERS.md`）
4. 涉及数据库结构变化时新增迁移文件，**不要修改已提交的迁移**
   （校验和会漂移，`migrate status` 会报 `drifted`）
5. 一个 PR 只做一件事。重构和功能混在一起没法 review
