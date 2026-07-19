import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Outage, OutagesResponse } from '@sense/shared';
import type { AppContext } from '../context.js';

const querySchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive().optional(),
});

export function registerOutageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const stmt = ctx.db.prepare(
    `SELECT id, started_ts AS startedTs, ended_ts AS endedTs FROM outages
     WHERE started_ts >= ? AND started_ts <= ?
     ORDER BY started_ts DESC LIMIT 100`,
  );

  app.get('/outages', async (req, reply): Promise<OutagesResponse | void> => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const now = Math.floor(Date.now() / 1000);
    const from = parsed.data.from ?? now - 30 * 86400;
    const to = parsed.data.to ?? now;
    return { outages: stmt.all(from, to) as Outage[] };
  });
}
