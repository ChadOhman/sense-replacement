import type { AppContext } from '../context.js';
import type { Scheduler } from './scheduler.js';
import { addDays, localDayStartTs, todayLocal } from '../lib/time.js';

export function registerTrendsJobs(ctx: AppContext, scheduler: Scheduler): void {
  const upsertDailyStmt = ctx.db.prepare(
    `INSERT INTO daily_summary (day, kwh, source, production_kwh) VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET kwh = excluded.kwh, source = excluded.source,
       production_kwh = COALESCE(excluded.production_kwh, production_kwh)`,
  );
  const upsertDeviceDailyStmt = ctx.db.prepare(
    `INSERT INTO device_daily (day, device_id, kwh) VALUES (?, ?, ?)
     ON CONFLICT(day, device_id) DO UPDATE SET kwh = excluded.kwh`,
  );
  const insertOnlyDailyStmt = ctx.db.prepare(
    `INSERT INTO daily_summary (day, kwh, source) VALUES (?, ?, 'rollup')
     ON CONFLICT(day) DO NOTHING`,
  );
  const hasDailyStmt = ctx.db.prepare('SELECT 1 FROM daily_summary WHERE day = ?');
  const deviceExistsStmt = ctx.db.prepare('SELECT 1 FROM devices WHERE id = ?');
  const rollupStmt = (resolution: number) =>
    ctx.db.prepare(
      `SELECT SUM(w_avg * ${resolution}) AS wsum, COUNT(*) * ${resolution} AS coverage
       FROM power_rollup WHERE resolution = ${resolution} AND bucket >= ? AND bucket < ?`,
    );
  const rollup30Stmt = rollupStmt(30);
  const rollup300Stmt = rollupStmt(300);
  const tz = () => ctx.sense.monitorTz ?? ctx.config.tz;

  async function fetchAndUpsertDay(day: string): Promise<boolean> {
    const trends = await ctx.sense.getTrends('DAY', `${day}T00:00:00`);
    const consumption = trends.consumption;
    if (!consumption) {
      ctx.log(`trends: no consumption data for ${day}`);
      return false;
    }
    // A nonzero production total also counts as solar detection (covers homes
    // where the realtime stream is down but trends still report generation).
    if ((trends.production?.total ?? 0) > 0 && ctx.kv.get('solar.detected') === null) {
      ctx.kv.set('solar.detected', '1');
      ctx.log('solar: production detected via trends');
    }
    ctx.db.transaction(() => {
      upsertDailyStmt.run(day, consumption.total, 'trends', trends.production?.total ?? null);
      for (const d of consumption.devices) {
        if (!d.total_kwh) continue;
        if (!deviceExistsStmt.get(d.id)) continue;
        upsertDeviceDailyStmt.run(day, d.id, d.total_kwh);
      }
    })();
    return true;
  }

  scheduler.register(
    'trends',
    15 * 60_000,
    async () => {
      await fetchAndUpsertDay(todayLocal(tz()));
    },
    { runImmediately: true },
  );

  scheduler.register('finalize-yesterday', 60 * 60_000, async () => {
    const localTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz(),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    const [hh, mm] = localTime.split(':').map(Number);
    const minutesOfDay = (hh ?? 0) * 60 + (mm ?? 0);
    if (minutesOfDay < 15 || minutesOfDay > 120) return; // window 00:15-02:00
    const yesterday = addDays(todayLocal(tz()), -1);
    const flagKey = `finalized.${yesterday}`;
    if (ctx.kv.get(flagKey)) return;
    if (await fetchAndUpsertDay(yesterday)) ctx.kv.set(flagKey, '1');
  });

  // Cloud-dead fallback: derive daily kWh from our own measured rollups for
  // any recent day the trends endpoint never filled in.
  scheduler.register('derive-missing', 60 * 60_000, async () => {
    const today = todayLocal(tz());
    for (let i = 1; i <= 7; i++) {
      const day = addDays(today, -i);
      if (hasDailyStmt.get(day)) continue;
      const dayStart = localDayStartTs(day, tz());
      const nextDayStart = localDayStartTs(addDays(day, 1), tz());
      let row = rollup30Stmt.get(dayStart, nextDayStart) as
        | { wsum: number | null; coverage: number }
        | undefined;
      if (!row?.wsum) {
        row = rollup300Stmt.get(dayStart, nextDayStart) as
          | { wsum: number | null; coverage: number }
          | undefined;
      }
      if (!row || row.wsum === null) continue;
      const daySeconds = nextDayStart - dayStart;
      if (row.coverage < daySeconds * 0.5) continue; // require >50% coverage
      insertOnlyDailyStmt.run(day, row.wsum / 3_600_000); // W*s -> kWh
    }
  });
}
