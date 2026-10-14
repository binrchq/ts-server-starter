/**
 * 审计事件的落库 sink。
 *
 * 审计与业务日志的关键差异：**审计不能因为「数据库慢」就同步阻塞请求**，
 * 但也不能悄悄丢事件（丢事件 = 合规缺口）。所以这里做三件事：
 *
 *  1. 有界队列 —— 内存不会因为数据库故障而无限增长
 *  2. 批量写入 —— 一次 INSERT 多行，避免每条事件一次往返
 *  3. 丢弃可观测 —— 丢了多少条要能查出来，而不是静默失败
 *
 * 队列满时丢的是**最新**的事件而不是最旧的：攻击特征通常出现在序列开头
 * （第一次失败尝试），保留先到的样本更有价值。
 */
import type { Logger } from '../shared/logger.js';
import type { AuditEvent, AuditSink } from './audit.js';

/** 由仓储实现（此处只依赖结构，避免 security 反向依赖 modules） */
export interface AuditEventWriter {
  writeMany(events: readonly AuditEvent[]): Promise<void>;
}

export interface BufferedAuditSinkStats {
  written: number;
  /** 队列满被丢弃的条数 */
  dropped: number;
  /** 写库失败被丢弃的条数 */
  failures: number;
  queued: number;
  /** 最后一次写库失败的原因，便于定位（例如表不存在、权限不足） */
  lastError?: string;
}

export interface BufferedAuditSink extends AuditSink {
  flush(): Promise<void>;
  close(): Promise<void>;
  stats(): BufferedAuditSinkStats;
}

export interface BufferedAuditSinkOptions {
  writer: AuditEventWriter;
  logger: Logger;
  /** 队列上限，默认 1000。超过后新事件被丢弃并计数 */
  capacity?: number;
  /** 攒到多少条触发一次写库，默认 20 */
  batchSize?: number;
  /** 定时冲刷间隔，默认 2s。定时器 unref，不会阻止进程退出 */
  flushIntervalMs?: number;
  name?: string;
}

export function createBufferedAuditSink(options: BufferedAuditSinkOptions): BufferedAuditSink {
  const { writer, logger } = options;
  const capacity = options.capacity ?? 1000;
  const batchSize = options.batchSize ?? 20;
  const name = options.name ?? 'database';

  const queue: AuditEvent[] = [];
  let written = 0;
  let dropped = 0;
  let failures = 0;
  let lastError: string | undefined;
  let flushing: Promise<void> | null = null;
  let closed = false;

  // 丢弃要打日志，但每条都打会把日志刷爆 —— 每丢 100 条提醒一次
  const dropLogInterval = 100;

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.splice(0, batchSize);
      try {
        await writer.writeMany(batch);
        written += batch.length;
        lastError = undefined;
      } catch (err) {
        // 不回队：数据库持续故障时回队会变成死循环 + 内存爆掉。
        // 丢多少条是可观测的（stats），运维据此补采日志 sink 里的副本。
        failures += batch.length;
        lastError = err instanceof Error ? err.message : String(err);
        logger.error(err, 'audit sink write failed', { sink: name, batchSize: batch.length, failures });
      }
    }
  }

  function scheduleFlush(): void {
    if (flushing || closed) return;
    flushing = drain().finally(() => {
      flushing = null;
    });
    // drain 内部已捕获异常，这里只需避免 unhandled rejection
    flushing.catch(() => undefined);
  }

  const timer = setInterval(() => {
    if (queue.length > 0) scheduleFlush();
  }, options.flushIntervalMs ?? 2000);
  // 不阻止进程退出：进程要退时靠 close() 冲刷
  timer.unref?.();

  return {
    name,

    write(event) {
      if (closed) return;
      if (queue.length >= capacity) {
        dropped += 1;
        if (dropped % dropLogInterval === 1) {
          logger.error(
            new Error('audit queue overflow'),
            'audit events are being dropped — database sink is too slow or unavailable',
            { sink: name, capacity, dropped, failures },
          );
        }
        return;
      }
      queue.push(event);
      if (queue.length >= batchSize) scheduleFlush();
    },

    flush() {
      return drain();
    },

    async close() {
      closed = true;
      clearInterval(timer);
      // 先等在途的一轮结束，再做最后冲刷，避免两次 drain 抢同一批数据
      if (flushing) await flushing;
      await drain();
    },

    stats() {
      return { written, dropped, failures, queued: queue.length, lastError };
    },
  };
}
