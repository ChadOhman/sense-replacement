import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SettingsResponse } from '@sense/shared';
import { getSettings, saveSettings, type AppContext } from '../context.js';

const putSchema = z.object({
  rateCentsPerKwh: z.number().nonnegative(),
  currency: z.string().min(1).max(8),
});

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/settings', async (): Promise<SettingsResponse> => getSettings(ctx));

  app.put('/settings', async (req, reply): Promise<SettingsResponse | void> => {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    saveSettings(ctx, parsed.data);
    return getSettings(ctx);
  });
}
