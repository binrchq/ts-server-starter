/**
 * 调度器的测试必须用「可控时钟」而不是 sleep ——
 * 否则测试要么慢，要么在 CI 上随机失败。
 * 这里靠短周期 + 轮询等待条件成立，避免依赖固定 sleep 时长。
 */
import { describe, expect, it } from 'vitest';
import { TimerWheel } from '../src/core/timer-wheel.js';
import { createLogger } from '../src/shared/logger.js';
import { createServiceContext } from '../src/core/context.js';

const logger = createLogger({ level: 'silent', format: 'json' });

function makeWheel(): { wheel: TimerWheel; stop: () => void } {
  const wheel = new TimerWheel({ logger, maxTickMs: 5 });
  // createServiceContext 返回 { ctx, dispose }，dispose 用于清掉超时定时器
  const { ctx, dispose } = createServiceContext({ logger });
  wheel.start(ctx);
  return {
    wheel,
    stop: () => {
      wheel.stop();
      dispose();
    },
  };
}

/** 轮询等待条件成立，最多等 timeoutMs */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met before timeout');
}

describe('TimerWheel', () => {
  it('重复注册同一个 id 直接抛错（早失败好过静默覆盖）', () => {
    const { wheel, stop } = makeWheel();
    wheel.add({ id: 'a', intervalMs: 50, handler: async () => undefined });
    expect(() => wheel.add({ id: 'a', intervalMs: 50, handler: async () => undefined })).toThrow(/already registered/);
    stop();
  });

  it('周期非法（<=0）被拒绝', () => {
    const { wheel, stop } = makeWheel();
    expect(() => wheel.add({ id: 'a', intervalMs: 0, handler: async () => undefined })).toThrow(/positive interval/);
    stop();
  });

  it('按周期重复执行，且不会堆积（执行完才排下一轮）', async () => {
    const { wheel, stop } = makeWheel();
    let runs = 0;
    wheel.add({
      id: 'tick',
      intervalMs: 20,
      immediate: true,
      handler: async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    await waitFor(() => runs >= 2);
    // 单次执行 30ms > 周期 20ms，若用 setInterval 会堆积；这里必须严格串行
    expect(runs).toBeLessThanOrEqual(3);
    stop();
  });

  it('maxConcurrent 生效：长任务不会被重复触发', async () => {
    const { wheel, stop } = makeWheel();
    let concurrent = 0;
    let peak = 0;
    wheel.add({
      id: 'slow',
      intervalMs: 5,
      immediate: true,
      maxConcurrent: 1,
      handler: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 25));
        concurrent -= 1;
      },
    });
    await waitFor(() => peak > 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(peak).toBe(1);
    stop();
  });

  it('依赖任务：依赖未完成时不调度', async () => {
    const { wheel, stop } = makeWheel();
    const order: string[] = [];
    wheel.add({
      id: 'base',
      intervalMs: 20,
      immediate: true,
      handler: async () => {
        order.push('base');
      },
    });
    wheel.add({
      id: 'dependent',
      intervalMs: 10,
      immediate: true,
      dependencies: ['base'],
      handler: async () => {
        order.push('dependent');
      },
    });
    await waitFor(() => order.includes('dependent'));
    expect(order.indexOf('base')).toBeLessThan(order.indexOf('dependent'));
    stop();
  });

  it('precondition 返回 false 时跳过本轮', async () => {
    const { wheel, stop } = makeWheel();
    let handlerRuns = 0;
    let skipped = 0;
    wheel.add({
      id: 'conditional',
      intervalMs: 10,
      immediate: true,
      precondition: () => {
        skipped += 1;
        return false;
      },
      handler: async () => {
        handlerRuns += 1;
      },
    });
    await waitFor(() => skipped >= 2);
    expect(handlerRuns).toBe(0);
    stop();
  });

  it('handler 抛错不会中断调度，错误进入 onCompleted / 状态里', async () => {
    const { wheel, stop } = makeWheel();
    const results: Array<{ ok: boolean }> = [];
    wheel.add({
      id: 'failing',
      intervalMs: 10,
      immediate: true,
      onCompleted: (result) => {
        results.push({ ok: result.ok });
      },
      handler: async () => {
        throw new Error('boom');
      },
    });
    await waitFor(() => results.length >= 2);
    expect(results.every((r) => !r.ok)).toBe(true);
    const snapshot = wheel.snapshot().find((t) => t.id === 'failing');
    expect(snapshot?.failures).toBeGreaterThanOrEqual(2);
    stop();
  });

  it('enable(false) 后停止执行，enable(true) 后恢复', async () => {
    const { wheel, stop } = makeWheel();
    let runs = 0;
    wheel.add({
      id: 'toggler',
      intervalMs: 10,
      immediate: true,
      handler: async () => {
        runs += 1;
      },
    });
    await waitFor(() => runs >= 1);
    wheel.enable('toggler', false);
    const frozen = runs;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs).toBe(frozen);
    wheel.enable('toggler', true);
    await waitFor(() => runs > frozen);
    stop();
  });

  it('stop() 后不再执行任何任务', async () => {
    const { wheel } = makeWheel();
    let runs = 0;
    wheel.add({
      id: 't',
      intervalMs: 10,
      immediate: true,
      handler: async () => {
        runs += 1;
      },
    });
    await waitFor(() => runs >= 1);
    wheel.stop();
    const frozen = runs;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs).toBe(frozen);
  });

  it('snapshot() 暴露可观测状态（供 /internal/status 使用）', () => {
    const { wheel, stop } = makeWheel();
    wheel.add({ id: 'a', intervalMs: 100, handler: async () => undefined });
    const snapshot = wheel.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ id: 'a', enabled: true, intervalMs: 100 });
    stop();
  });
});
