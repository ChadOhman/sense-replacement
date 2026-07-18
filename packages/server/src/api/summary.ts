import type { FastifyInstance } from 'fastify';
import type { SummaryResponse } from '@sense/shared';
import { getSettings, kwhToCost, type AppContext } from '../context.js';
import { addDays, monthOf, todayLocal } from '../lib/time.js';

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
    const settings = getSettings(ctx);
    const now = Math.floor(Date.now() / 1000);

    const todayKwh = (kwhForDayStmt.get(today) as { kwh: number }).kwh;
    const weekKwh = (kwhSinceStmt.get(addDays(today, -7), today) as { kwh: number }).kwh;
    const monthKwh = (kwhForMonthStmt.get(monthOf(today)) as { kwh: number }).kwh;

    let alwaysOnW = (alwaysOnStmt.get(30, now - 86400) as { w: number | null }).w;
    if (alwaysOnW === null) {
      alwaysOnW = (alwaysOnStmt.get(300, now - 86400) as { w: number | null }).w;
    }

    return {
      todayKwh,
      todayCost: kwhToCost(todayKwh, settings),
      weekKwh,
      weekCost: kwhToCost(weekKwh, settings),
      monthKwh,
      monthCost: kwhToCost(monthKwh, settings),
      alwaysOnW,
      nowW: ctx.ring.latest()?.w ?? null,
    };
  });
}
