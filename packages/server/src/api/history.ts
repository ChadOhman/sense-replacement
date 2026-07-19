import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  DeviceUsage,
  PowerHistoryResponse,
  PowerPoint,
  UsageBucket,
  UsageResponse,
  UsageScale,
} from '@sense/shared';
import type { AppContext } from '../context.js';
import { addDays, todayLocal } from '../lib/time.js';
import { pickResolution } from '../collector/rollup.js';

const powerQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().positive(),
});

const usageQuerySchema = z.object({
  scale: z.enum(['day', 'week', 'month', 'year']).default('day'),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  compare: z.coerce.number().int().min(0).max(1).default(0),
});

export function registerHistoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const powerStmt = ctx.db.prepare(
    `SELECT bucket AS t, w_avg AS wAvg, w_min AS wMin, w_max AS wMax, solar_w_avg AS solarWAvg
     FROM power_rollup WHERE resolution = ? AND bucket >= ? AND bucket < ?
     ORDER BY bucket`,
  );

  app.get('/history/power', async (req, reply): Promise<PowerHistoryResponse | void> => {
    const parsed = powerQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { from } = parsed.data;
    const to = Math.min(parsed.data.to, Math.floor(Date.now() / 1000) + 60);
    if (from >= to) return reply.status(400).send({ error: 'from must be before to' });
    const resolution = pickResolution(from, to);
    const points = powerStmt.all(resolution, from, to) as PowerPoint[];
    return { resolution, points };
  });

  const rangeDaysFor = (scale: UsageScale): number =>
    scale === 'day' ? 30 : scale === 'week' ? 12 * 7 : scale === 'month' ? 365 : 10 * 365;

  const bucketExprFor = (scale: UsageScale): string => {
    switch (scale) {
      case 'day':
        return 'day';
      case 'week':
        // Label each ISO week by its Monday.
        return `date(day, '-' || ((strftime('%w', day) + 6) % 7) || ' days')`;
      case 'month':
        return `strftime('%Y-%m', day)`;
      case 'year':
        return `strftime('%Y', day)`;
    }
  };

  /** Per-day rows grouped into labelled buckets with rate-aware costs. */
  const bucketsForRange = (scale: UsageScale, startDay: string, end: string): UsageBucket[] => {
    const bucketExpr = bucketExprFor(scale);
    const rows = ctx.db
      .prepare(
        `SELECT ${bucketExpr} AS label, day, kwh FROM daily_summary
         WHERE day > ? AND day <= ? ORDER BY day`,
      )
      .all(startDay, end) as { label: string; day: string; kwh: number }[];
    const byLabel = new Map<string, UsageBucket>();
    for (const r of rows) {
      const b = byLabel.get(r.label) ?? { label: r.label, kwh: 0, cost: 0 };
      b.kwh += r.kwh;
      b.cost += ctx.costs.costForDay(r.day);
      byLabel.set(r.label, b);
    }
    return [...byLabel.values()].sort((a, z) => a.label.localeCompare(z.label));
  };

  app.get('/history/usage', async (req, reply): Promise<UsageResponse | void> => {
    const parsed = usageQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { scale } = parsed.data;
    const tz = ctx.sense.monitorTz ?? ctx.config.tz;
    const end = parsed.data.start ?? todayLocal(tz);
    const startDay = addDays(end, -rangeDaysFor(scale));

    const buckets = bucketsForRange(scale, startDay, end);
    const totalKwh = buckets.reduce((s, b) => s + b.kwh, 0);

    const deviceRows = ctx.db
      .prepare(
        `SELECT dd.device_id AS deviceId, d.name, d.icon, SUM(dd.kwh) AS kwh
         FROM device_daily dd JOIN devices d ON d.id = dd.device_id
         WHERE dd.day > ? AND dd.day <= ?
         GROUP BY dd.device_id ORDER BY kwh DESC`,
      )
      .all(startDay, end) as { deviceId: string; name: string; icon: string | null; kwh: number }[];
    const top = deviceRows.slice(0, 8);
    const rest = deviceRows.slice(8);
    const devices: DeviceUsage[] = top.map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      icon: d.icon,
      kwh: d.kwh,
      cost: ctx.costs.costForDeviceRange(d.deviceId, addDays(startDay, 1), end),
    }));
    if (rest.length > 0) {
      const otherKwh = rest.reduce((s, d) => s + d.kwh, 0);
      devices.push({
        deviceId: 'other',
        name: 'Other devices',
        icon: null,
        kwh: otherKwh,
        cost: ctx.costs.costForKwhOnDay(otherKwh, end),
      });
    }

    const totalCost = buckets.reduce((s, b) => s + b.cost, 0);
    const production = ctx.db
      .prepare(
        'SELECT SUM(production_kwh) AS kwh FROM daily_summary WHERE day > ? AND day <= ? AND production_kwh IS NOT NULL',
      )
      .get(startDay, end) as { kwh: number | null };
    const response: UsageResponse = { scale, buckets, totalKwh, totalCost, devices };
    if (production.kwh !== null) response.totalProductionKwh = production.kwh;
    if (parsed.data.compare === 1) {
      response.compare = bucketsForRange(scale, addDays(startDay, -365), addDays(end, -365));
    }
    return response;
  });
}
