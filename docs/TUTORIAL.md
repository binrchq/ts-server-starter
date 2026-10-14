# 教程：从零加一个业务模块

目标：加一个 `order`（订单）模块，包含

- `POST /api/v1/orders` 创建订单（需登录）
- `GET /api/v1/orders` 分页列表（需登录）
- `GET /api/v1/orders/:id` 详情（需登录，只能看自己的）
- `GET /admin/orders` 全量列表（需 admin）
- 建表迁移
- 定时任务：每 5 分钟把超时未支付的订单标记为 `expired`
- 测试

全程不需要改任何已有模块的内部实现 —— 只需要在 `wire.ts` 里注册一次。
如果做不到这点，说明分层已经漏了。

---

## 1. 数据模型与迁移

```bash
pnpm migrate create add_orders
```

```sql
-- migrations/postgres/20260201000001_add_orders.up.sql
CREATE TABLE IF NOT EXISTS orders (
  id          VARCHAR(64)   NOT NULL PRIMARY KEY,
  user_id     VARCHAR(64)   NOT NULL,
  amount_cents BIGINT       NOT NULL CHECK (amount_cents > 0),
  status      VARCHAR(16)   NOT NULL DEFAULT 'pending',
  -- 用 TIMESTAMPTZ 不用 TIMESTAMP：跨时区/夏令时的时候你就知道为什么了
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 列表查询是 (user_id, created_at DESC)，索引要照这个顺序建
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders (user_id, created_at DESC);
-- 定时任务要扫「pending 且已过期」，部分索引比全表索引小得多
CREATE INDEX IF NOT EXISTS idx_orders_pending_expiry ON orders (expires_at) WHERE status = 'pending';
```

```sql
-- migrations/postgres/20260201000001_add_orders.down.sql
DROP INDEX IF EXISTS idx_orders_pending_expiry;
DROP INDEX IF EXISTS idx_orders_user_created;
DROP TABLE IF EXISTS orders;
```

```bash
pnpm migrate status   # pending 里应该出现新迁移
pnpm migrate up
```

> 迁移一旦提交过就不要再改内容：`schema_migrations` 里记了 sha256，
> 改动会让 `migrate status` 报 `drifted`。要改就再加一个迁移。

---

## 2. 入参校验

```ts
// src/modules/order/order.schema.ts
import { z } from 'zod';

export const createOrderBodySchema = z.object({
  // coerce：查询串/表单进来的都是字符串，这里统一转数字并限制范围
  amountCents: z.coerce.number().int().positive().max(100_000_000),
  expiresInMinutes: z.coerce.number().int().min(1).max(60 * 24 * 30).default(30),
});

export const listOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'paid', 'expired']).optional(),
});

export const orderIdParamSchema = z.object({ id: z.string().min(1).max(64) });

export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
```

校验在路由层自动执行（`schemas: { body, query, params }`），
校验失败会被 `errorHandler` 统一转成 `400 VALIDATION_ERROR` + 字段级 `details`。
控制器里 `req.body` 已经是校验过的结构，可以直接断言类型。

---

## 3. 仓储

仓储的定义与实现分开：接口让服务和测试不关心底层是 SQL 还是内存。

```ts
// src/modules/order/order.repository.ts
import type { Database } from '../../infra/database/types.js';
import type { SqlDialect } from '../../infra/database/sql.js';
import { dialectOf } from '../../infra/database/sql.js';
import type { CreateOrderBody, ListOrdersQuery } from './order.schema.js';
import { randomUUID } from 'node:crypto';

export type OrderStatus = 'pending' | 'paid' | 'expired';

export interface OrderRecord {
  id: string;
  userId: string;
  amountCents: number;
  status: OrderStatus;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderRepository {
  findById(id: string): Promise<OrderRecord | null>;
  list(userId: string | null, query: ListOrdersQuery): Promise<{ items: OrderRecord[]; total: number }>;
  create(userId: string, input: CreateOrderBody): Promise<OrderRecord>;
  markExpired(ids: readonly string[]): Promise<number>;
  findExpiring(now: Date, limit: number): Promise<OrderRecord[]>;
}
```

SQL 实现要点（完整写法参考 `src/modules/audit/audit.repository.ts`）：

- **一律用 `?` 占位符**，`bind()` 会按方言翻译成 `$1/$2`
- 值转换（`row.amount_cents` 在 pg 里是 string，因为 `BIGINT` 超出 JS 安全整数范围）要在
  这一层做掉，别让 `number | string` 泄漏到 service
- `markExpired` 一次 `UPDATE ... WHERE id IN (...)` 而不是循环单条：
  N 次往返 vs 1 次，定时任务上是数量级差别

```ts
export class SqlOrderRepository implements OrderRepository {
  private readonly dialect: SqlDialect;

  constructor(
    private readonly database: Database,
    private readonly table = 'orders',
  ) {
    this.dialect = dialectOf(database.driver);
  }

  async create(userId: string, input: CreateOrderBody): Promise<OrderRecord> {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);
    const now = new Date();
    await this.database.query(
      `INSERT INTO ${this.table} (id, user_id, amount_cents, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, input.amountCents, 'pending', expiresAt, now, now],
    );
    return { id, userId, amountCents: input.amountCents, status: 'pending', expiresAt, createdAt: now, updatedAt: now };
  }
  // ...其余方法
}
```

测试里换成内存实现（下面第 8 节），业务代码完全不知道。

---

## 4. 服务

服务层是**唯一**放业务规则的地方：控制器不判断权限，仓储不判断状态机。

```ts
// src/modules/order/order.service.ts
import { ForbiddenError, NotFoundError } from '../../shared/errors.js';
import type { Cache } from '../../infra/cache/types.js';
import type { Auditor } from '../../security/audit.js';
import { AuditAction } from '../../security/audit.js';
import type { Logger } from '../../shared/logger.js';
import type { OrderRepository, OrderRecord } from './order.repository.js';
import type { CreateOrderBody, ListOrdersQuery } from './order.schema.js';

export interface OrderServiceOptions {
  repository: OrderRepository;
  cache: Cache;
  auditor: Auditor;
  logger: Logger;
}

/** 所有人共用同一份缓存 key 时，key 里必须带上 userId，否则会串数据 */
const listCacheKey = (userId: string | null, query: ListOrdersQuery): string =>
  `orders:${userId ?? 'all'}:${query.status ?? 'any'}:${query.limit}:${query.offset}`;

export class OrderService {
  constructor(private readonly options: OrderServiceOptions) {}

  async create(userId: string, input: CreateOrderBody): Promise<OrderRecord> {
    const order = await this.options.repository.create(userId, input);
    this.options.logger.info('order created', { orderId: order.id, userId });
    this.options.auditor.record({
      action: 'order.created',
      outcome: 'success',
      userId,
      resource: `order:${order.id}`,
      detail: { amountCents: order.amountCents },
    });
    return order;
  }

  async list(userId: string, query: ListOrdersQuery) {
    // 缓存 30s：列表页刷新频繁但不需要强一致
    return this.options.cache.remember(listCacheKey(userId, query), 30, () =>
      this.options.repository.list(userId, query),
    );
  }

  async listAll(query: ListOrdersQuery) {
    return this.options.repository.list(null, query);
  }

  async get(userId: string, id: string, isAdmin = false): Promise<OrderRecord> {
    const order = await this.options.repository.findById(id);
    if (!order) throw new NotFoundError('Order not found.');
    // 越权读别人的订单：返回 403 而不是 404，便于前端给出明确提示；
    // 若担心暴露"该 id 存在"，改成 404 也可以，但要在整个接口上保持一致
    if (!isAdmin && order.userId !== userId) {
      this.options.auditor.record({
        action: AuditAction.AccessDenied,
        outcome: 'denied',
        userId,
        resource: `order:${id}`,
        detail: { reason: 'not the owner' },
      });
      throw new ForbiddenError('You do not have access to this order.');
    }
    return order;
  }

  /** 定时任务：把超时未支付的订单标记为 expired */
  async expireOverdue(now = new Date(), limit = 200): Promise<number> {
    const stale = await this.options.repository.findExpiring(now, limit);
    if (stale.length === 0) return 0;
    const affected = await this.options.repository.markExpired(stale.map((order) => order.id));
    this.options.logger.info('orders expired', { scanned: stale.length, affected });
    return affected;
  }
}
```

---

## 5. 控制器

控制器只做三件事：取身份、调用服务、写响应。**不要在这里写业务判断。**

```ts
// src/modules/order/order.controller.ts
import type { Request, Response } from 'express';
import { created, ok, paginated } from '../../shared/http/respond.js';
import { requirePrincipal } from '../../app/middleware/authenticate.js';
import type { OrderService } from './order.service.js';
import type { CreateOrderBody, ListOrdersQuery } from './order.schema.js';

export interface OrderController {
  create(req: Request, res: Response): Promise<void>;
  list(req: Request, res: Response): Promise<void>;
  get(req: Request, res: Response): Promise<void>;
  listAll(req: Request, res: Response): Promise<void>;
}

export function createOrderController(service: OrderService): OrderController {
  const userId = (req: Request): string => requirePrincipal(req).userId;

  return {
    async create(req, res) {
      created(res, await service.create(userId(req), req.body as CreateOrderBody));
    },
    async list(req, res) {
      paginated(res, await service.list(userId(req), req.query as unknown as ListOrdersQuery));
    },
    async get(req, res) {
      const principal = requirePrincipal(req);
      ok(res, await service.get(principal.userId, String(req.params.id), principal.roles.includes('admin')));
    },
    async listAll(req, res) {
      paginated(res, await service.listAll(req.query as unknown as ListOrdersQuery));
    },
  };
}
```

控制器返回的 Promise 不需要 `try/catch`：`asyncHandler` 会把 rejection 转给
`errorHandler`。**忘记 await 也不会静默失败** —— `no-floating-promises` 规则会拦住它。

---

## 6. 模块入口

`index.ts` 必须显式声明「这个模块需要什么」和「它暴露到哪一层」。
这两个信息都在一个文件里，review 时一眼能看完。

```ts
// src/modules/order/index.ts
import type { RouteGroup } from '../../app/routes/route-group.js';
import type { Cache } from '../../infra/cache/types.js';
import type { TimerWheel } from '../../core/timer-wheel.js';
import type { Auditor } from '../../security/audit.js';
import type { Logger } from '../../shared/logger.js';
import { createOrderController, type OrderController } from './order.controller.js';
import { OrderService } from './order.service.js';
import type { OrderRepository } from './order.repository.js';
import { createOrderBodySchema, listOrdersQuerySchema, orderIdParamSchema } from './order.schema.js';

export * from './order.controller.js';
export * from './order.repository.js';
export * from './order.schema.js';
export * from './order.service.js';

export interface OrderModuleOptions {
  /** 测试/换实现时注入；默认由 wire 提供 SQL 实现 */
  repository: OrderRepository;
  cache: Cache;
  auditor: Auditor;
  logger: Logger;
  expireIntervalMs?: number;
}

export interface OrderModule {
  service: OrderService;
  controller: OrderController;
  mount(group: RouteGroup): void;
  mountAdmin(group: RouteGroup): void;
  registerTimers(timerWheel: TimerWheel): void;
}

export function createOrderModule(options: OrderModuleOptions): OrderModule {
  const service = new OrderService({
    repository: options.repository,
    cache: options.cache,
    auditor: options.auditor,
    logger: options.logger,
  });
  const controller = createOrderController(service);

  return {
    service,
    controller,

    mount(group) {
      group.post('/orders', controller.create, {
        access: 'user',
        schemas: { body: createOrderBodySchema },
        // 写法是 strict:<key>。写成裸 'strict' 编译不过（类型上是模板字面量联合），
        // 这是刻意的：限流策略写错会让人以为"已经防了"，属最危险的一类笔误
        rateLimit: 'strict:write',
        description: '创建订单',
      });
      group.get('/orders', controller.list, {
        access: 'user',
        schemas: { query: listOrdersQuerySchema },
        description: '我的订单列表（缓存 30s）',
      });
      group.get('/orders/:id', controller.get, {
        access: 'user',
        schemas: { params: orderIdParamSchema },
        description: '订单详情（仅本人或 admin）',
      });
    },

    mountAdmin(group) {
      group.get('/orders', controller.listAll, {
        schemas: { query: listOrdersQuerySchema },
        description: '全量订单列表',
      });
    },

    registerTimers(timerWheel) {
      timerWheel.add({
        id: 'order.expire-overdue',
        intervalMs: options.expireIntervalMs ?? 5 * 60_000,
        handler: async () => {
          await service.expireOverdue();
        },
        maxConcurrent: 1, // 本轮没跑完就跳过下一轮，避免任务堆积
        timeoutMs: 30_000,
        onCompleted: (result) => {
          if (!result.ok) options.logger.error(result.error, 'order expiry sweep failed');
        },
      });
    },
  };
}
```

`access: 'user'` 会自动挂上「认证 + 角色校验」，你不必在控制器里再检查一次。

---

## 7. 装配

一共三处改动，都在 `src/serve/wire.ts`：

```ts
// ① 导入
import { createOrderModule } from '../modules/order/index.js';
import { SqlOrderRepository } from '../modules/order/order.repository.js';

// ② 在 modules 对象里加一项（放在模块构造区）
const orderModule = createOrderModule({
  repository: new SqlOrderRepository(database),
  cache,
  auditor: security.auditor,
  logger,
});

const modules: Modules = {
  // ...已有的
  order: orderModule,
};

// ③ 路由与定时任务
//    - outer / admin 路由器里调用 mount / mountAdmin
//    - 定时任务在「启动期副作用」那一段注册
modules.order.registerTimers(timerWheel);
```

`src/app/routes/v1/types.ts` 的 `Modules` 接口加一行 `order: OrderModule;`，
然后：

- `src/app/routes/v1/outer/router.ts` → `deps.modules.order.mount(group);`
- `src/app/routes/v1/admin/router.ts` → `deps.modules.order.mountAdmin(group);`

最后：

```bash
pnpm routes | grep orders     # 确认路由注册上了
pnpm dev
```

> 如果 DI 写错了（比如少传 `repository`），启动时会立刻报错 ——
> `Serve.run()` 里的 `container.warmup()` 就是干这个的。

---

## 8. 测试

### 单元测试：服务层用内存仓储

```ts
// tests/order.test.ts
import { describe, expect, it } from 'vitest';
import { OrderService } from '../src/modules/order/order.service.js';
import { StubCache } from './helpers/stub-infra.js';
import { Auditor } from '../src/security/audit.js';
import { createLogger } from '../src/shared/logger.js';

class InMemoryOrderRepository implements OrderRepository {
  private readonly byId = new Map<string, OrderRecord>();
  // ...实现 findById / list / create / markExpired / findExpiring
}

describe('订单服务', () => {
  it('越权查看别人的订单返回 403 并留下 denied 审计', async () => {
    const events: AuditEvent[] = [];
    const service = new OrderService({
      repository: new InMemoryOrderRepository(),
      cache: new StubCache(),
      auditor: new Auditor([{ name: 'capture', write: (e) => void events.push(e) }]),
      logger: createLogger({ level: 'silent', format: 'text', output: 'stdout' }),
    });

    const order = await service.create('owner-1', { amountCents: 100, expiresInMinutes: 30 });
    await expect(service.get('intruder-2', order.id)).rejects.toThrow(/access/i);
    expect(events.at(-1)).toMatchObject({ outcome: 'denied' });
  });
});
```

### 集成测试：只换掉基础设施

```ts
import { wire } from '../src/serve/wire.js';
import { StubDatabase, StubCache, StubQueue, StubState } from './helpers/stub-infra.js';
import { request, startLayers } from './helpers/http-harness.js';

const wired = await wire({
  config: testConfig(),
  infrastructure: { database: new StubDatabase(), cache: new StubCache(), mq: new StubQueue(), state: new StubState() },
});
const layers = await startLayers(wired);

const res = await request(layers.outer!.baseUrl, '/api/v1/orders', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...bearer(token) },
  body: JSON.stringify({ amountCents: 500 }),
});
expect(res.status).toBe(201);
```

规则（`CONTRIBUTING.md` 里也有）：

- **不要 `sleep`**：等异步结果就轮询条件
- **替身必须诚实**：不支持的能力抛错，不要静默返回空结果
- 测试结束要 `close()` 掉 listener 和容器，否则 vitest 会挂着不退出

---

## 9. 收尾清单

- [ ] `pnpm migrate status` 无 `drifted`、无 `pending`
- [ ] `pnpm verify` 全绿（类型 + lint + 测试）
- [ ] `pnpm routes` 里能看到新路由，且 `access` 级别正确
- [ ] 拒绝类分支（越权、限流、非法状态）都写了审计事件
- [ ] 索引覆盖了真实的查询条件（不是"给每个字段都建一个"）
- [ ] 涉及安全边界的改动，回到 `docs/SECURITY.md` 过一遍自检清单
- [ ] 有行为变更就更新 `docs/`，别让文档和代码分叉
