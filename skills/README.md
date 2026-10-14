# Skills

给 AI 编码助手（以及新加入的人）用的操作手册。每个文件是一类任务的
**约束 + 骨架 + 检查清单**，目标是让产出一次就符合本仓库的约定，
而不是"看起来能跑"。

## 目录

| 文件 | 什么时候看 |
| --- | --- |
| [`gen-module.md`](gen-module.md) | 新增一个业务模块（service + controller + repository + 路由） |
| [`gen-service.md`](gen-service.md) | 只加服务层逻辑 / 需要缓存、MQ、审计、事务 |
| [`gen-controller.md`](gen-controller.md) | 只加/改控制器 |
| [`gen-router.md`](gen-router.md) | 只加/改路由或调整访问级别、限流档位 |
| [`add-adapter.md`](add-adapter.md) | 新增基础设施驱动（数据库 / 缓存 / MQ / 状态） |

## 通用约定（所有任务都适用）

1. **先读代码再写代码**。看一个同类模块的现有实现（`src/modules/task/` 是最完整的例子），
   照着它的形状写，别自己发明结构。
2. **依赖方向不能反**：`shared` ← `core`/`infra` ← `security` ← `modules` ← `app` ← `serve`。
   需要跨模块协作时走 DI token 或消息队列，不要直接 import 另一个模块。
3. **安全相关的三件事一次做完**：声明 `access` 级别、拒绝类分支写审计事件、
   SQL 全部参数化。这三件漏一件就得上线后补丁。
4. **注释写"为什么"**。反直觉的选择、被否决的方案、踩过的坑 —— 这些最值钱。
5. **测试替身必须诚实**：不支持的能力抛错，不要静默返回空结果。
6. **提交前**跑 `pnpm verify`（类型 + lint + 测试），并确认 `pnpm routes` 输出符合预期。
7. **不确定就问**，不要猜。猜错的成本远高于问一句。
