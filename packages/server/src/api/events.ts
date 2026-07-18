import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeviceEvent, EventsResponse } from '@sense/shared';
import type { AppContext } from '../context.js';

const querySchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive().optional(),
  deviceId: z.string().optional(),
});

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/events', async (req, reply): Promise<EventsResponse | void> => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const now = Math.floor(Date.now() / 1000);
    const from = parsed.data.from ?? now - 86400;
    const to = parsed.data.to ?? now;
    const deviceFilter = parsed.data.deviceId ? 'AND e.device_id = ?' : '';
    const stmt = ctx.db.prepare(
      `SELECT e.id, e.device_id AS deviceId, d.name AS deviceName, e.ts, e.type, e.watts, e.source
       FROM events e JOIN devices d ON d.id = e.device_id
       WHERE e.ts >= ? AND e.ts <= ? ${deviceFilter}
       ORDER BY e.ts DESC LIMIT 200`,
    );
    const args: (number | string)[] = [from, to];
    if (parsed.data.deviceId) args.push(parsed.data.deviceId);
    const events = stmt.all(...args) as DeviceEvent[];
    return { events };
  });
}
