/**
 * DI 容器的测试重点：
 *  - 单例语义（同一个 token 拿到同一个实例）
 *  - 循环依赖要在启动时报错，而不是运行时递归爆栈
 *  - 销毁顺序
 *  - 缺注册要报出可读的错误（token 名字），否则排查靠猜
 */
import { describe, expect, it, vi } from 'vitest';
import { Container, createToken } from '../src/core/container.js';

interface Greeter {
  greet(): string;
}
const GreeterToken = createToken<Greeter>('Greeter');
const CountToken = createToken<number>('Count');
const NoDepsToken = createToken<Greeter>('NoDeps');
/** 模拟需要释放的资源（连接池、MQ 客户端……） */
interface Disposable {
  close?(): void;
  [Symbol.asyncDispose]?(): Promise<void>;
}
const DisposableToken = createToken<Disposable>('Disposable');
const OtherDisposableToken = createToken<Disposable>('OtherDisposable');

describe('Container', () => {
  it('value() 注册立即生效，get() 返回同一实例', () => {
    const container = new Container();
    const greeter: Greeter = { greet: () => 'hi' };
    container.value(GreeterToken, greeter);
    expect(container.get(GreeterToken)).toBe(greeter);
  });

  it('register() 惰性求值：未 get 不会构造', () => {
    const container = new Container();
    const factory = vi.fn(() => ({ greet: () => 'lazy' }));
    container.register(GreeterToken, factory);
    expect(factory).not.toHaveBeenCalled();
    container.get(GreeterToken);
    container.get(GreeterToken);
    // 单例：只构造一次
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('warmup() 只实例化 eager 依赖，让装配错误在启动阶段暴露', async () => {
    const container = new Container();
    const eagerFactory = vi.fn(() => ({ greet: () => 'warmed' }));
    const lazyFactory = vi.fn(() => ({ greet: () => 'lazy' }));
    container.register(GreeterToken, eagerFactory, { eager: true });
    container.register(NoDepsToken, lazyFactory);
    await container.warmup();
    expect(eagerFactory).toHaveBeenCalledTimes(1);
    // 非 eager 的不该被顺带构造：否则启动会为一个可能用不到的重资源买单
    expect(lazyFactory).not.toHaveBeenCalled();
  });

  it('async 工厂用 get() 取会给出明确提示，resolve() 才能取', async () => {
    const container = new Container();
    container.register(GreeterToken, async () => ({ greet: () => 'async' }));
    expect(() => container.get(GreeterToken)).toThrow(/resolve\(\)/);
    expect((await container.resolve(GreeterToken)).greet()).toBe('async');
  });

  it('未注册的 token 报错包含 token 名，便于定位', () => {
    const container = new Container();
    expect(() => container.get(GreeterToken)).toThrow(/Greeter/);
  });

  it('has() 区分已注册与未注册', () => {
    const container = new Container();
    container.value(CountToken, 1);
    expect(container.has(CountToken)).toBe(true);
    expect(container.has(GreeterToken)).toBe(false);
  });

  it('循环依赖被明确拒绝，而不是递归爆栈', () => {
    const a = createToken<unknown>('A');
    const b = createToken<unknown>('B');
    const container = new Container();
    container.register(a, (c) => c.get(b));
    container.register(b, (c) => c.get(a));
    expect(() => container.get(a)).toThrow(/circular/i);
  });

  it('dispose() 逆序释放实现了 dispose/close/asyncDispose 的实例', async () => {
    const order: string[] = [];
    const container = new Container();
    container.register(DisposableToken, () => ({
      close: () => {
        order.push('greeter');
      },
    }));
    container.register(OtherDisposableToken, (): Disposable => ({
      async [Symbol.asyncDispose]() {
        await Promise.resolve();
        order.push('count');
      },
    }));
    container.get(DisposableToken);
    container.get(OtherDisposableToken);
    await container.dispose();
    // 后注册的先释放（与创建顺序相反）
    expect(order).toEqual(['count', 'greeter']);
  });

  it('单个资源释放失败不会阻断其它资源的清理', async () => {
    const order: string[] = [];
    const container = new Container();
    container.register(DisposableToken, () => ({
      close: () => {
        order.push('greeter');
      },
    }));
    container.register(OtherDisposableToken, (): Disposable => ({
      close: () => {
        throw new Error('close exploded');
      },
    }));
    container.get(DisposableToken);
    container.get(OtherDisposableToken);
    await expect(container.dispose()).resolves.toBeUndefined();
    // 抛错的那个之后仍然继续释放
    expect(order).toEqual(['greeter']);
  });

  it('未实例化的注册不会被释放（惰性依赖不该凭空连接）', async () => {
    const container = new Container();
    const close = vi.fn();
    container.register(DisposableToken, () => ({ close }));
    await container.dispose();
    expect(close).not.toHaveBeenCalled();
  });

  it('dispose() 之后 get() 报错，避免使用已释放的资源', async () => {
    const container = new Container();
    container.value(GreeterToken, { greet: () => 'x' });
    await container.dispose();
    expect(() => container.get(GreeterToken)).toThrow(/disposed/i);
  });

  it('createScope() 继承父容器，但注册是隔离的', () => {
    const parent = new Container();
    parent.value(GreeterToken, { greet: () => 'parent' });
    const scope = parent.createScope();
    // 子容器能读到父容器的值
    expect(scope.get(GreeterToken).greet()).toBe('parent');
    // 子容器的覆盖不影响父容器
    scope.value(GreeterToken, { greet: () => 'child' });
    expect(scope.get(GreeterToken).greet()).toBe('child');
    expect(parent.get(GreeterToken).greet()).toBe('parent');
  });
});
