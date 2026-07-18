import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { registerStatusRoutes } from './status.js';
import { registerLiveRoute } from './live.js';
import { registerHistoryRoutes } from './history.js';
import { registerDeviceRoutes } from './devices.js';
import { registerEventRoutes } from './events.js';
import { registerSummaryRoutes } from './summary.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSetupRoutes } from './setup.js';

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(
    async (api) => {
      registerStatusRoutes(api, ctx);
      registerLiveRoute(api, ctx);
      registerHistoryRoutes(api, ctx);
      registerDeviceRoutes(api, ctx);
      registerEventRoutes(api, ctx);
      registerSummaryRoutes(api, ctx);
      registerSettingsRoutes(api, ctx);
      registerSetupRoutes(api, ctx);
    },
    { prefix: '/api' },
  );
}
