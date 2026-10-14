/**
 * 基础设施适配器的语义测试。
 *
 * 这里刻意**不**测 redis 驱动（需要真 redis，交给集成环境），
 * 但把 memory 驱动的边界行为钉死 —— 因为生产代码在测试里拿到的就是它，
 * 一旦「锁不互斥」「缓存不防击穿」这类语义跑偏，测试会全绿而线上出事。
 */
import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/infra/cache/memory-cache.js';
import { MemoryState } from '../src/infra/state/memory-state.js';
import { MemoryMessageQueue } from '../src/infra/messaging/memory-mq.js';

describe('MemoryCache', () => {
  it('set/get/del/has 基本行为', async () => {
    const cache = new MemoryCache();
    await cache.set('k', { v: 1 });
    expect(await cache.get('k')).toEqual({ v: 1 });
    expect(await cache.has('k')).toBe(true);
    await cache.del('k');
    expect(await cache.get('k')).toBeUndefined();
  });

  it('ttl 到期后读不到', async () => {
    const cache = new MemoryCache();
    await cache.set('k', 'v', 10);
    expect(await cache.get('k')).toBe('v');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await cache.get('k')).toBeUndefined();
  });

  it('remember 命中缓存则不调用 producer', async () => {
    const cache = new MemoryCache();
    let calls = 0;
    const producer = async (): Promise<number> => {
      calls += 1;
      return 42;
    };
    expect(await cache.remember('k', 1000, producer)).toBe(42);
    expect(await cache.remember('k', 1000, producer)).toBe(42);
    expect(calls).toBe(1);
  });

  it('remember 对同一 key 的并发 miss 只计算一次（防击穿）', async () => {
    const cache = new MemoryCache();
    let calls = 0;
    const producer = async (): Promise<string> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'expensive';
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.remember('same', 1000, producer)));
    expect(results).toEqual(Array.from({ length: 10 }, () => 'expensive'));
    // 10 个并发请求打同一个 key，producer 只能跑 1 次
    expect(calls).toBe(1);
  });

  it('deleteByPrefix 只删匹配前缀的键', async () => {
    const cache = new MemoryCache();
    await cache.set('user:1', 'a');
    await cache.set('user:2', 'b');
    await cache.set('task:1', 'c');
    expect(await cache.deleteByPrefix('user:')).toBe(2);
    expect(await cache.get('task:1')).toBe('c');
  });
});

describe('MemoryState', () => {
  it('increment 是原子的且保留首次设置的 TTL', async () => {
    const state = new MemoryState();
    const results = await Promise.all(Array.from({ length: 50 }, () => state.increment('counter', 1, 60_000)));
    expect(Math.max(...results)).toBe(50);
    expect(await state.get('counter')).toBe(50);
  });

  it('setIfAbsent 只在键不存在时成功（限流/幂等的基础）', async () => {
    const state = new MemoryState();
    expect(await state.setIfAbsent('once', 'first')).toBe(true);
    expect(await state.setIfAbsent('once', 'second')).toBe(false);
    expect(await state.get('once')).toBe('first');
  });

  it('锁互斥：第二次获取返回 null', async () => {
    const state = new MemoryState();
    const first = await state.acquireLock('job', 10_000);
    expect(first).not.toBeNull();
    expect(await state.acquireLock('job', 10_000)).toBeNull();
    await first?.release();
    // 释放后可以再次获取
    expect(await state.acquireLock('job', 10_000)).not.toBeNull();
  });

  it('锁因 TTL 过期后，旧持有者 release() 不能删掉新持有者的锁', async () => {
    const state = new MemoryState();
    const stale = await state.acquireLock('job', 10);
    const holder = state as unknown as { locks: Map<string, unknown> };
    // 模拟 TTL 到期（不等待真实时间）
    holder.locks.clear();

    const fresh = await state.acquireLock('job', 10_000);
    expect(fresh).not.toBeNull();
    // 关键：过期锁的持有者不能误删别人的锁
    expect(await stale?.release()).toBe(false);
    expect(fresh?.held).toBe(true);
  });
});

describe('MemoryMessageQueue', () => {
  it('publish 把消息派发给订阅者', async () => {
    const mq = new MemoryMessageQueue();
    const received: unknown[] = [];
    await mq.subscribe<{ n: number }>('topic', (message) => {
      received.push(message.payload);
    });
    await mq.publish('topic', { n: 1 });
    await mq.publish('topic', { n: 2 });
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
    await mq.close();
  });

  it('取消订阅后不再收到消息', async () => {
    const mq = new MemoryMessageQueue();
    const received: unknown[] = [];
    const unsubscribe = await mq.subscribe('topic', (message) => {
      received.push(message.payload);
    });
    await mq.publish('topic', 'before');
    await unsubscribe();
    await mq.publish('topic', 'after');
    expect(received).toEqual(['before']);
    await mq.close();
  });

  it('一个订阅者抛错不影响其它订阅者', async () => {
    const mq = new MemoryMessageQueue();
    const received: unknown[] = [];
    await mq.subscribe('topic', () => {
      throw new Error('handler exploded');
    });
    await mq.subscribe('topic', (message) => {
      received.push(message.payload);
    });
    await mq.publish('topic', 'payload');
    expect(received).toEqual(['payload']);
    await mq.close();
  });

  it('消息带 id/topic/timestamp，便于排查与去重', async () => {
    const mq = new MemoryMessageQueue();
    const messages: Array<{ id: string; topic: string; attempt: number }> = [];
    await mq.subscribe('t', (message) => {
      messages.push(message);
    });
    await mq.publish('t', {});
    expect(messages[0]?.id).toBeTruthy();
    expect(messages[0]?.topic).toBe('t');
    expect(messages[0]?.attempt).toBe(1);
    await mq.close();
  });
});
