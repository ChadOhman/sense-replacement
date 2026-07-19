import type { AppContext } from '../context.js';
import { Scheduler } from './scheduler.js';
import { RealtimeCollector } from './realtime.js';
import { registerTrendsJobs } from './trends.js';
import { getBackfillStatus, registerBackfillJob } from './backfill.js';
import { registerDeviceSyncJob } from './devices.js';
import { registerTimelineJob } from './timeline.js';
import { registerRetentionJob } from './retention.js';

export { getBackfillStatus };

export function startCollectors(ctx: AppContext): {
  scheduler: Scheduler;
  realtimeCollector: RealtimeCollector;
  stop(): void;
} {
  const scheduler = new Scheduler(ctx);
  const realtimeCollector = new RealtimeCollector(ctx);

  // device-sync first so real metadata lands before realtime's synthetic rows
  registerDeviceSyncJob(ctx, scheduler);
  registerTrendsJobs(ctx, scheduler);
  registerBackfillJob(ctx, scheduler);
  registerTimelineJob(ctx, scheduler);
  registerRetentionJob(ctx, scheduler);

  realtimeCollector.start();
  ctx.getActiveBrownout = () => realtimeCollector.activeBrownout;
  ctx.getActiveNeutralEpisode = () => {
    const a = realtimeCollector.activeNeutralEpisode;
    return a
      ? { startedTs: a.startedTs, maxSpreadVolts: a.maxSpreadVolts, nominalVolts: a.nominalVolts }
      : null;
  };
  ctx.sense.startRealtime();

  return {
    scheduler,
    realtimeCollector,
    stop() {
      scheduler.stop();
      realtimeCollector.stop();
      ctx.sense.stopRealtime();
    },
  };
}
