import type { CycleReport } from '@sense/shared';
import { getBillingSettings, getSettings, type AppContext } from '../context.js';
import type { Scheduler } from './scheduler.js';
import { addDays, todayLocal } from '../lib/time.js';
import { cycleWindow } from '../lib/rates.js';
import { getStoredAnomalies } from './health.js';

/** Generates a summary report when a billing cycle closes. Runs hourly and is
 *  idempotent per period (UNIQUE on reports.period). */
export function registerReportJob(ctx: AppContext, scheduler: Scheduler): void {
  const hasReportStmt = ctx.db.prepare('SELECT 1 FROM reports WHERE period = ?');
  const insertStmt = ctx.db.prepare(
    'INSERT OR IGNORE INTO reports (period, generated_ts, json) VALUES (?, ?, ?)',
  );
  const daysStmt = ctx.db.prepare(
    'SELECT day, kwh FROM daily_summary WHERE day >= ? AND day < ? ORDER BY day',
  );
  const topDevicesStmt = ctx.db.prepare(
    `SELECT d.name, d.id, SUM(dd.kwh) AS kwh FROM device_daily dd
     JOIN devices d ON d.id = dd.device_id
     WHERE dd.day >= ? AND dd.day < ?
     GROUP BY dd.device_id ORDER BY kwh DESC LIMIT 5`,
  );
  const countStmt = (table: string) =>
    ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE started_ts >= ? AND started_ts < ?`);
  const brownoutCount = countStmt('voltage_events');
  const divergenceCount = countStmt('neutral_events');
  const stallCount = countStmt('stall_events');
  const outageCount = countStmt('outages');
  const deviceNameStmt = ctx.db.prepare('SELECT name FROM devices WHERE id = ?');

  scheduler.register(
    'report',
    3600_000,
    async () => {
      const tz = ctx.sense.monitorTz ?? ctx.config.tz;
      const today = todayLocal(tz);
      const { billingCycleDay } = getBillingSettings(ctx);
      const current = cycleWindow(today, billingCycleDay);
      // Previous cycle = the one containing the day before this cycle started.
      const prev = cycleWindow(addDays(current.startDay, -1), billingCycleDay);
      if (hasReportStmt.get(prev.startDay)) return;

      const days = daysStmt.all(prev.startDay, prev.endDay) as { day: string; kwh: number }[];
      if (days.length === 0) return; // no data for that cycle — nothing to report

      const totalKwh = days.reduce((s, d) => s + d.kwh, 0);
      const totalCost = days.reduce((s, d) => s + ctx.costs.costForDay(d.day), 0);

      const prevPrev = cycleWindow(addDays(prev.startDay, -1), billingCycleDay);
      const prevPrevDays = daysStmt.all(prevPrev.startDay, prevPrev.endDay) as {
        day: string;
        kwh: number;
      }[];
      const prevCycleCost =
        prevPrevDays.length > 0
          ? prevPrevDays.reduce((s, d) => s + ctx.costs.costForDay(d.day), 0)
          : null;

      const startTs = Date.parse(`${prev.startDay}T00:00:00Z`) / 1000;
      const endTs = Date.parse(`${prev.endDay}T00:00:00Z`) / 1000;
      const anomalies = Object.entries(getStoredAnomalies(ctx)).map(([id, a]) => ({
        name: (deviceNameStmt.get(id) as { name: string } | undefined)?.name ?? id,
        pct: a.pct,
        direction: a.direction,
      }));

      const report: CycleReport = {
        period: prev.startDay,
        periodEnd: prev.endDay,
        generatedTs: Math.floor(Date.now() / 1000),
        totalKwh,
        totalCost,
        currency: getSettings(ctx).currency,
        prevCycleCost,
        topDevices: (
          topDevicesStmt.all(prev.startDay, prev.endDay) as {
            name: string;
            id: string;
            kwh: number;
          }[]
        ).map((d) => ({
          name: d.name,
          kwh: d.kwh,
          cost: ctx.costs.costForKwhOnDay(d.kwh, prev.endDay),
        })),
        powerQuality: {
          brownouts: (brownoutCount.get(startTs, endTs) as { n: number }).n,
          divergences: (divergenceCount.get(startTs, endTs) as { n: number }).n,
          stalls: (stallCount.get(startTs, endTs) as { n: number }).n,
          outages: (outageCount.get(startTs, endTs) as { n: number }).n,
        },
        anomalies,
      };
      insertStmt.run(prev.startDay, report.generatedTs, JSON.stringify(report));
      ctx.log(`report: generated for cycle ${prev.startDay} — ${totalKwh.toFixed(0)} kWh`);
    },
    { runImmediately: true },
  );
}
