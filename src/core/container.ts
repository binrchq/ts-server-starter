/**
 * 运行时依赖注入容器。
 *
 * Go 版靠 Wire 在编译期生成装配代码。TS 没有等价的编译期 DI，
 * 因此这里用「类型化 token + 惰性单例」在运行时做同样的事：
 *
 *   const DB = createToken<Database>('database')
 *   container.register(DB, (c) => createDatabase(c.get(ConfigToken)))
 *   const db = container.get(DB)   // 编译期就知道是 Database
 *
 * 与手写装配相比的取舍：少写一层样板、可测试可替换，代价是
 * 装配错误从「编译期」推迟到「启动期」—— 所以启动时显式 eager 解析关键依赖，
 * 让错误尽早暴露（见 warmup()）。
 */

export interface Token<T> {
  readonly key: symbol;
  readonly name: string;
  /** 仅用于类型携带，运行时不存在 */
  readonly __type?: T;
}

export function createToken<T>(name: string): Token<T> {
  return { key: Symbol(name), name };
}

export type Factory<T> = (container: Container) => T | Promise<T>;

export interface RegisterOptions {
  /** 是否缓存实例，默认 true */
  singleton?: boolean;
  /** 是否在 warmup() 时主动实例化（尽早暴露装配错误） */
  eager?: boolean;
}

interface Registration<T = unknown> {
  token: Token<T>;
  factory: Factory<T>;
  singleton: boolean;
  eager: boolean;
  instance?: T;
  instantiated: boolean;
  resolving: boolean;
}

/** 需要释放的资源：Symbol.asyncDispose > dispose() > close() */
type DisposableLike = {
  [Symbol.asyncDispose]?: () => Promise<void>;
  [Symbol.dispose]?: () => void;
  dispose?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
};

export class Container {
  private readonly registrations = new Map<symbol, Registration<never>>();
  private readonly parent: Container | null;
  private disposed = false;

  constructor(parent: Container | null = null) {
    this.parent = parent;
  }

  register<T>(token: Token<T>, factory: Factory<T>, options: RegisterOptions = {}): this {
    this.assertAlive();
    this.registrations.set(token.key, {
      token,
      factory,
      singleton: options.singleton ?? true,
      eager: options.eager ?? false,
      instantiated: false,
      resolving: false,
      // 注册表内部用 unknown 存储：token 泛型在 map 里无法保持，
      // 取出时由 get()/resolve() 用调用方的 token 恢复类型。
    } as unknown as Registration<never>);
    return this;
  }

  /** 注册一个已构造好的值（配置、logger 这类无生命周期对象） */
  value<T>(token: Token<T>, instance: T): this {
    this.assertAlive();
    this.registrations.set(token.key, {
      token,
      factory: () => instance,
      singleton: true,
      eager: false,
      instance,
      instantiated: true,
      resolving: false,
    } as unknown as Registration<never>);
    return this;
  }

  has(token: Token<unknown>): boolean {
    if (this.disposed) return false;
    return this.registrations.has(token.key) || (this.parent?.has(token) ?? false);
  }

  /** 同步取；若工厂是 async 会抛错，请改用 resolve() */
  get<T>(token: Token<T>): T {
    // 先判存活：dispose 之后注册表已清空，若只报「dependency not registered」
    // 会把人引向「少注册了一个依赖」这个错误方向
    this.assertAlive();
    const registration = this.find<T>(token);
    if (!registration) throw new Error(`dependency not registered: ${token.name}`);
    if (registration.instantiated) return registration.instance as T;
    // 同步路径同样要标记 resolving：否则 A→B→A 这种环会直接爆栈，
    // 报出来的是 "Maximum call stack size exceeded"，完全看不出真正原因
    if (registration.resolving) throw new Error(`circular dependency detected at "${token.name}"`);

    registration.resolving = true;
    try {
      const produced = registration.factory(this);
      if (produced instanceof Promise) {
        throw new Error(`dependency "${token.name}" is async; use container.resolve() instead of get()`);
      }
      return this.finish(registration, produced);
    } finally {
      registration.resolving = false;
    }
  }

  /** 异步取（工厂可以是 async） */
  async resolve<T>(token: Token<T>): Promise<T> {
    this.assertAlive();
    const registration = this.find<T>(token);
    if (!registration) throw new Error(`dependency not registered: ${token.name}`);
    if (registration.instantiated) return registration.instance as T;
    if (registration.resolving) throw new Error(`circular dependency detected at "${token.name}"`);

    registration.resolving = true;
    try {
      const produced = await registration.factory(this);
      return this.finish(registration, produced);
    } finally {
      registration.resolving = false;
    }
  }

  /** 创建一个子作用域：可覆盖部分依赖，未注册的回落到父容器 */
  createScope(): Container {
    return new Container(this);
  }

  /** 提前实例化所有 eager 依赖，把装配错误压到启动阶段 */
  async warmup(): Promise<void> {
    for (const registration of this.registrations.values()) {
      if (!registration.eager) continue;
      await this.resolve(registration.token);
    }
  }

  /** 逆序释放所有单例（含父容器） */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const registrations = [...this.registrations.values()].reverse();
    for (const registration of registrations) {
      if (!registration.instantiated || registration.instance === undefined) continue;
      await disposeInstance(registration.instance, registration.token.name);
    }
    this.registrations.clear();
    await this.parent?.dispose();
  }

  get size(): number {
    return this.registrations.size;
  }

  private find<T>(token: Token<T>): Registration<T> | undefined {
    const local = this.registrations.get(token.key) as Registration<T> | undefined;
    if (local) return local;
    return this.parent?.find(token);
  }

  private finish<T>(registration: Registration<T>, produced: T): T {
    if (registration.singleton) {
      registration.instance = produced;
      registration.instantiated = true;
    }
    return produced;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('container has been disposed');
  }
}

async function disposeInstance(instance: DisposableLike, name: string): Promise<void> {
  try {
    // 取到局部变量再调用：可选成员的 typeof 收窄不会保留到调用处
    const asyncDispose = instance[Symbol.asyncDispose];
    if (typeof asyncDispose === 'function') return await asyncDispose.call(instance);
    const syncDispose = instance[Symbol.dispose];
    if (typeof syncDispose === 'function') return syncDispose.call(instance);
    if (typeof instance.dispose === 'function') return await instance.dispose();
    if (typeof instance.close === 'function') return await instance.close();
  } catch {
    // 释放失败不该阻断其它资源的清理
    process.stderr.write(`[container] failed to dispose "${name}"\n`);
  }
}
