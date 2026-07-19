import type { FastifyInstance } from 'fastify';
import type { SummaryResponse } from '@sense/shared';
import type { AppContext } from '../context.js';
import { addDays, monthOf, todayLocal } from '../lib/time.js';
import { getStoredCreep } from '../collector/health.js';

export function registerSummaryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const kwhForDayStmt = ctx.db.prepare(
    'SELECT COALESCE(SUM(kwh), 0) AS kwh FROM daily_summary WHERE day = ?',
  );
  const kwhSinceStmt = ctx.db.prepare(
    'SELECT COALESCE(SUM(kwh), 0) AS kwh FROM daily_summary WHERE day > ? AND day <= ?',
  );
  const kwhForMonthStmt = ctx.db.prepare(
    `SELECT COALESCE(SUM(kwh), 0) AS kwh FROM daily_summary WHERE day LIKE ? || '%'`,
  );
  const alwaysOnStmt = ctx.db.prepare(
    'SELECT MIN(w_min) AS w FROM power_rollup WHERE resolution = ? AND bucket >= ?',
  );

  app.get('/summary', async (): Promise<SummaryResponse> => {
    const tz = ctx.sense.monitorTz ?? ctx.config.tz;
    const today = todayLocal(tz);
    const now = Math.floor(Date.now() / 1000);

    const todayKwh = (kwhForDayStmt.get(today) as { kwh: number }).kwh;
    const weekKwh = (kwhSinceStmt.get(addDays(today, -7), today) as { kwh: number }).kwh;
    const monthKwh = (kwhForMonthStmt.get(monthOf(today)) as { kwh: number }).kwh;

    let alwaysOnW = (alwaysOnStmt.get(30, now - 86400) as { w: number | null }).w;
    if (alwaysOnW === null) {
      alwaysOnW = (alwaysOnStmt.get(300, now - 86400) as { w: number | null }).w;
    }

    let weekCost = 0;
    for (let i = 0; i < 7; i++) weekCost += ctx.costs.costForDay(addDays(today, -i));
    let monthCost = 0;
    for (let d = `${monthOf(today)}-01`; d <= today; d = addDays(d, 1)) {
      monthCost += ctx.costs.costForDay(d);
    }

    return {
      todayKwh,
      todayCost: ctx.costs.costForDay(today),
      weekKwh,
      weekCost,
      monthKwh,
      monthCost,
      alwaysOnW,
      nowW: ctx.ring.latest()?.w ?? null,
      alwaysOnCreep: getStoredCreep(ctx),
      solarTodayKwh: (
        ctx.db
          .prepare('SELECT production_kwh AS kwh FROM daily_summary WHERE day = ?')
          .get(today) as { kwh: number | null } | undefined
      )?.kwh ?? null,
    };
  });
}
