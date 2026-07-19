import type { FastifyInstance } from 'fastify';
import type { StatusResponse } from '@sense/shared';
import type { AppContext } from '../context.js';
import { dbSizeBytes } from '../db/index.js';
import { getLastBackup } from '../collector/backup.js';

export function registerStatusRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/status', async (): Promise<StatusResponse> => {
    return {
      authState: ctx.sense.authState,
      cloudConnected: ctx.sense.realtimeConnected,
      lastFrameTs: ctx.ring.latest()?.ts ?? null,
      collectors: [...ctx.collectorStatus.values()],
      backfill: ctx.getBackfillStatus(),
      dbSizeBytes: dbSizeBytes(ctx.config.dataDir),
      mock: ctx.config.mock,
      lastBackup: getLastBackup(ctx),
      activeBrownout: ctx.getActiveBrownout(),
      activeNeutralEpisode: ctx.getActiveNeutralEpisode(),
      activeStall: ctx.getActiveStall(),
    };
  });
}
