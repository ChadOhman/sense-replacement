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
import { registerVoltageRoutes } from './voltage.js';
import { registerAlertRoutes } from './alerts.js';
import { registerBillingRoutes } from './billing.js';
import { registerOutageRoutes } from './outages.js';
import { registerExportRoutes } from './export.js';
import { registerReportRoutes } from './reports.js';
import { registerMetricsRoutes } from './metrics.js';
import { registerNilmRoutes } from './nilm.js';

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
      registerVoltageRoutes(api, ctx);
      registerAlertRoutes(api, ctx);
      registerBillingRoutes(api, ctx);
      registerOutageRoutes(api, ctx);
      registerExportRoutes(api, ctx);
      registerReportRoutes(api, ctx);
      registerNilmRoutes(api, ctx);
    },
    { prefix: '/api' },
  );
  // Prometheus convention: /metrics at the root, not under /api.
  registerMetricsRoutes(app, ctx);
}
