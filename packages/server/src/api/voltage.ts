import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  NeutralEvent,
  NeutralEventsResponse,
  NeutralHealth,
  VoltageEvent,
  VoltageEventsResponse,
} from '@sense/shared';
import type { AppContext } from '../context.js';

/** 7-day assessment thresholds: any episode is worth flagging; frequent or
 *  severe divergence is the classic floating-neutral pattern. */
const ALERT_EVENTS_7D = 5;
const ALERT_SPREAD_VOLTS = 20;

const querySchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive().optional(),
});

export function registerVoltageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const stmt = ctx.db.prepare(
    `SELECT id, started_ts AS startedTs, ended_ts AS endedTs, leg, min_volts AS minVolts,
            nominal_volts AS nominalVolts
     FROM voltage_events
     WHERE started_ts >= ? AND started_ts <= ?
     ORDER BY started_ts DESC LIMIT 100`,
  );

  app.get('/voltage-events', async (req, reply): Promise<VoltageEventsResponse | void> => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const now = Math.floor(Date.now() / 1000);
    const from = parsed.data.from ?? now - 30 * 86400;
    const to = parsed.data.to ?? now;
    const events = stmt.all(from, to) as VoltageEvent[];
    return { events };
  });

  const neutralStmt = ctx.db.prepare(
    `SELECT id, started_ts AS startedTs, ended_ts AS endedTs, max_spread_volts AS maxSpreadVolts,
            high_leg AS highLeg, peak_high_volts AS peakHighVolts, peak_low_volts AS peakLowVolts,
            nominal_volts AS nominalVolts
     FROM neutral_events
     WHERE started_ts >= ? AND started_ts <= ?
     ORDER BY started_ts DESC LIMIT 100`,
  );
  const neutralHealthStmt = ctx.db.prepare(
    `SELECT COUNT(*) AS n, MAX(max_spread_volts) AS maxSpread
     FROM neutral_events WHERE started_ts >= ?`,
  );

  app.get('/neutral-events', async (req, reply): Promise<NeutralEventsResponse | void> => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const now = Math.floor(Date.now() / 1000);
    const from = parsed.data.from ?? now - 30 * 86400;
    const to = parsed.data.to ?? now;
    const events = neutralStmt.all(from, to) as NeutralEvent[];
    const row = neutralHealthStmt.get(now - 7 * 86400) as { n: number; maxSpread: number | null };
    const health: NeutralHealth = {
      state:
        row.n >= ALERT_EVENTS_7D || (row.maxSpread ?? 0) >= ALERT_SPREAD_VOLTS
          ? 'alert'
          : row.n > 0
            ? 'suspect'
            : 'ok',
      events7d: row.n,
      maxSpread7dVolts: row.maxSpread,
    };
    return { health, events };
  });
}
