/**
 * 服务上下文 —— Go 的 context.Context 在 Node 里的等价物。
 *
 * 只保留两样真正需要透传的东西：
 *   signal —— 取消/超时（AbortSignal 是所有 Node API 的通用取消协议）
 *   logger —— 带服务名分量的结构化日志
 */
import type { Logger } from '../shared/logger.js';

export interface ServiceContext {
  /** 触发该次 start/stop 的取消信号；超时或父级取消时 abort */
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

export interface CreateServiceContextOptions {
  logger: Logger;
  /** 该阶段的超时（毫秒），到点自动 abort */
  timeoutMs?: number;
  /** 外部信号，例如进程 SIGTERM */
  parent?: AbortSignal;
  /** 附加到 logger 的分量字段 */
  fields?: Record<string, unknown>;
}

/**
 * 创建一个带超时的服务上下文。超时后 signal.aborted 为 true，
 * 服务实现应当检查它并尽快返回，而不是硬扛。
 */
export function createServiceContext(options: CreateServiceContextOptions): {
  ctx: ServiceContext;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new Error('service operation timed out')), options.timeoutMs);
    timer.unref?.();
  }

  const onParentAbort = () => controller.abort(options.parent?.reason);
  options.parent?.addEventListener('abort', onParentAbort, { once: true });

  return {
    ctx: {
      signal: controller.signal,
      logger: options.fields ? options.logger.child(options.fields) : options.logger,
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      options.parent?.removeEventListener('abort', onParentAbort);
    },
  };
}
