import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  NeutralEvent,
  NeutralEventsResponse,
  NeutralHealth,
  StallEvent,
  StallEventsResponse,
  VoltageEvent,
  VoltageEventsResponse,
  VoltageHistoryResponse,
  VoltagePoint,
  VoltageSummaryResponse,
} from '@sense/shared';
import type { AppContext } from '../context.js';
import { pickResolution } from '../collector/rollup.js';

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

  const stallStmt = ctx.db.prepare(
    `SELECT id, started_ts AS startedTs, ended_ts AS endedTs, spike_count AS spikeCount,
            avg_spike_w AS avgSpikeW, max_spike_w AS maxSpikeW
     FROM stall_events
     WHERE started_ts >= ? AND started_ts <= ?
     ORDER BY started_ts DESC LIMIT 100`,
  );
  const stallCountStmt = ctx.db.prepare(
    'SELECT COUNT(*) AS n FROM stall_events WHERE started_ts >= ?',
  );

  app.get('/stall-events', async (req, reply): Promise<StallEventsResponse | void> => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const now = Math.floor(Date.now() / 1000);
    const from = parsed.data.from ?? now - 30 * 86400;
    const to = parsed.data.to ?? now;
    const events = stallStmt.all(from, to) as StallEvent[];
    const count = stallCountStmt.get(now - 30 * 86400) as { n: number };
    return { events, count30d: count.n };
  });

  const voltageHistoryStmt = ctx.db.prepare(
    `SELECT bucket AS t, leg, v_avg AS vAvg, v_min AS vMin, v_max AS vMax
     FROM voltage_rollup WHERE resolution = ? AND bucket >= ? AND bucket < ?
     ORDER BY bucket`,
  );

  app.get('/voltage-history', async (req, reply): Promise<VoltageHistoryResponse | void> => {
    const parsed = z
      .object({
        from: z.coerce.number().int().nonnegative(),
        to: z.coerce.number().int().positive(),
      })
      .safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { from, to } = parsed.data;
    if (from >= to) return reply.status(400).send({ error: 'from must be before to' });
    const resolution = pickResolution(from, to);
    const rows = voltageHistoryStmt.all(resolution, from, to) as (VoltagePoint & { leg: number })[];
    const legs: VoltagePoint[][] = [];
    for (const r of rows) {
      (legs[r.leg] ??= []).push({ t: r.t, vAvg: r.vAvg, vMin: r.vMin, vMax: r.vMax });
    }
    for (let i = 0; i < legs.length; i++) legs[i] ??= [];
    return { resolution, legs };
  });

  const legStats24hStmt = ctx.db.prepare(
    `SELECT leg,
            SUM(v_avg * sample_count) / SUM(sample_count) AS avg,
            MIN(v_avg) AS minSustained,
            MAX(v_avg) AS maxSustained
     FROM voltage_rollup WHERE resolution = ? AND bucket >= ?
     GROUP BY leg ORDER BY leg`,
  );
  // Dips/spikes are counted from 5-minute buckets only: 30s rows overlap them
  // after compaction and would double-count.
  const outOfBandStmt = ctx.db.prepare(
    `SELECT bucket AS t, leg, v_min AS vMin, v_max AS vMax
     FROM voltage_rollup
     WHERE resolution = 300 AND bucket >= ? AND (v_min < ? OR v_max > ?)
     ORDER BY bucket DESC LIMIT 500`,
  );

  app.get('/voltage-summary', async (): Promise<VoltageSummaryResponse> => {
    const now = Math.floor(Date.now() / 1000);
    let stats = legStats24hStmt.all(30, now - 86400) as {
      leg: number;
      avg: number;
      minSustained: number;
      maxSustained: number;
    }[];
    if (stats.length === 0) stats = legStats24hStmt.all(300, now - 86400) as typeof stats;

    const overallAvg =
      stats.length > 0 ? stats.reduce((s, l) => s + l.avg, 0) / stats.length : 120;
    const nominalVolts = Math.min(130, Math.max(110, overallAvg));
    const lowBand = nominalVolts * 0.95;
    const highBand = nominalVolts * 1.05;

    const legs: VoltageSummaryResponse['legs'] = [];
    for (const s of stats) {
      legs[s.leg] = { avg: s.avg, minSustained: s.minSustained, maxSustained: s.maxSustained };
    }
    for (let i = 0; i < legs.length; i++) {
      legs[i] ??= { avg: null, minSustained: null, maxSustained: null };
    }

    const outRows = outOfBandStmt.all(now - 30 * 86400, lowBand, highBand) as {
      t: number;
      leg: number;
      vMin: number;
      vMax: number;
    }[];
    let dips = 0;
    let spikes = 0;
    const recent: VoltageSummaryResponse['recent'] = [];
    for (const r of outRows) {
      const isDip = r.vMin < lowBand;
      const isSpike = r.vMax > highBand;
      if (isDip) dips += 1;
      if (isSpike) spikes += 1;
      if (recent.length < 20) {
        recent.push({
          t: r.t,
          leg: r.leg,
          kind: isDip ? 'dip' : 'spike',
          volts: isDip ? r.vMin : r.vMax,
        });
      }
    }

    return {
      nowVolts: ctx.ring.latest()?.voltageLegs ?? [],
      nominalVolts,
      legs,
      dips30d: dips,
      spikes30d: spikes,
      recent,
    };
  });
}
