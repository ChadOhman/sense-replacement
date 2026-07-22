import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AlertSettings, DetectionSettings } from '@sense/shared';
import {
  getAlertSettings,
  getDetectionSettings,
  saveAlertSettings,
  saveDetectionSettings,
  type AppContext,
} from '../context.js';

const detectionSettingsSchema = z.object({
  stallMaxDutyCycle: z.number().min(0.05).max(0.9),
  nilmTriggerW: z.number().min(5).max(500),
  nilmClusterSplitDistance: z.number().min(20).max(2000),
});

const alertSettingsSchema = z.object({
  ntfyUrl: z.string().max(500),
  webhookUrl: z.string().max(500),
  enabled: z.object({
    brownout: z.boolean(),
    neutral: z.boolean(),
    stall: z.boolean(),
    device_finished: z.boolean(),
    alwayson_creep: z.boolean(),
    device_anomaly: z.boolean(),
  }),
  quietHours: z
    .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
    .nullable(),
  finishedDeviceIds: z.array(z.string()).max(100),
  finishedMinRuntimeS: z.number().int().min(0).max(86400),
});

export function registerAlertRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/alerts/settings', async (): Promise<AlertSettings> => getAlertSettings(ctx));

  app.put('/alerts/settings', async (req, reply): Promise<AlertSettings | void> => {
    const parsed = alertSettingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    saveAlertSettings(ctx, parsed.data);
    return getAlertSettings(ctx);
  });

  app.get('/detection/settings', async (): Promise<DetectionSettings> => getDetectionSettings(ctx));

  app.put('/detection/settings', async (req, reply): Promise<DetectionSettings | void> => {
    const parsed = detectionSettingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    saveDetectionSettings(ctx, parsed.data);
    ctx.applyDetectionSettings();
    return getDetectionSettings(ctx);
  });

  /** Fires a test notification through the configured channels. */
  app.post('/alerts/test', async (_req, reply) => {
    const settings = getAlertSettings(ctx);
    if (!settings.ntfyUrl && !settings.webhookUrl) {
      return reply.status(400).send({ error: 'No notification channel configured' });
    }
    const results: string[] = [];
    if (settings.ntfyUrl) {
      const res = await fetch(settings.ntfyUrl, {
        method: 'POST',
        headers: { Title: 'Sense Monitor test', Tags: 'white_check_mark' },
        body: 'Test notification — alerts are working.',
      }).catch((err: Error) => ({ ok: false, status: err.message }) as const);
      results.push(`ntfy: ${res.ok ? 'ok' : res.status}`);
    }
    if (settings.webhookUrl) {
      const res = await fetch(settings.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'test', ts: Math.floor(Date.now() / 1000), message: 'Test notification' }),
      }).catch((err: Error) => ({ ok: false, status: err.message }) as const);
      results.push(`webhook: ${res.ok ? 'ok' : res.status}`);
    }
    return { ok: true, results };
  });
}
