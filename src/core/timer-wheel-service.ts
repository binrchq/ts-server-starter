/**
 * 把 TimerWheel 适配成 Service，纳入统一的生命周期编排。
 * 好处：进程启动/停止的时序只有一处定义（ServiceManager），
 * 不需要在 main 里手工维护「先起定时器再起 HTTP」这类隐式顺序。
 */
import type { ServiceContext } from './context.js';
import { AbstractService } from './service.js';
import type { TimerWheel } from './timer-wheel.js';

export class TimerWheelService extends AbstractService {
  readonly name = 'timer-wheel';

  constructor(private readonly wheel: TimerWheel) {
    super();
  }

  protected async onStart(ctx: ServiceContext): Promise<void> {
    this.wheel.start(ctx);
  }

  protected async onStop(_ctx: ServiceContext): Promise<void> {
    this.wheel.stop();
  }
}
