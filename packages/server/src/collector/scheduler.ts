import type { AppContext } from '../context.js';

export interface RegisterOptions {
  runImmediately?: boolean;
}

/**
 * Lightweight job scheduler: each job runs on its own setTimeout loop with
 * +-10% jitter so periodic jobs don't align into thundering herds. A job's
 * failure is recorded in ctx.collectorStatus and never kills the loop.
 */
export class Scheduler {
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(private readonly ctx: AppContext) {}

  register(
    name: string,
    intervalMs: number,
    fn: () => Promise<void>,
    opts: RegisterOptions = {},
  ): void {
    const scheduleNext = (): void => {
      if (this.stopped) return;
      const jitter = intervalMs * (0.9 + 0.2 * Math.random()); // +-10%
      const t = setTimeout(() => {
        this.timers.delete(t);
        void runOnce();
      }, jitter);
      this.timers.add(t);
    };

    const runOnce = async (): Promise<void> => {
      if (this.stopped) return;
      const status = this.ctx.collectorStatus.get(name) ?? {
        name,
        lastRun: null,
        lastSuccess: null,
        lastError: null,
      };
      status.lastRun = Math.floor(Date.now() / 1000);
      try {
        await fn();
        status.lastSuccess = Math.floor(Date.now() / 1000);
        status.lastError = null;
      } catch (err) {
        status.lastError = err instanceof Error ? err.message : String(err);
        this.ctx.log(`collector[${name}] failed: ${status.lastError}`);
      }
      this.ctx.collectorStatus.set(name, status);
      scheduleNext();
    };

    if (opts.runImmediately) void runOnce();
    else scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
