import type { DeviceAnomalyInfo } from '@sense/shared';
import { emitEvent, type AppContext } from '../context.js';
import type { Scheduler } from './scheduler.js';
import { addDays, localDayStartTs, todayLocal } from '../lib/time.js';
import { computeAlwaysOnCreep, computeDeviceAnomaly, findGaps } from './analytics.js';

const ANOMALIES_KEY = 'health.anomalies';
const CREEP_KEY = 'health.creep';
const ANOMALY_NOTIFIED_PREFIX = 'health.anomaly.notified.';
const CREEP_NOTIFIED_KEY = 'health.creep.notified';
const NOTIFY_COOLDOWN_S = 7 * 86400;

export function getStoredAnomalies(ctx: Pick<AppContext, 'kv'>): Record<string, DeviceAnomalyInfo> {
  return ctx.kv.getJson<Record<string, DeviceAnomalyInfo>>(ANOMALIES_KEY) ?? {};
}

export function getStoredCreep(
  ctx: Pick<AppContext, 'kv'>,
): { currentW: number; baselineW: number; pct: number } | null {
  return ctx.kv.getJson<{ currentW: number; baselineW: number; pct: number }>(CREEP_KEY);
}

export function registerHealthJobs(ctx: AppContext, scheduler: Scheduler): void {
  const tz = () => ctx.sense.monitorTz ?? ctx.config.tz;
  const upsertMetricsStmt = ctx.db.prepare(
    `INSERT INTO daily_metrics (day, always_on_w) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET always_on_w = excluded.always_on_w`,
  );
  const setWeatherStmt = ctx.db.prepare(
    `INSERT INTO daily_metrics (day, hdd, cdd) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET hdd = excluded.hdd, cdd = excluded.cdd`,
  );
  const missingWeatherStmt = ctx.db.prepare(
    `SELECT day FROM daily_metrics WHERE hdd IS NULL AND day >= ? AND day < ? ORDER BY day LIMIT 30`,
  );
  const minAvgStmt = ctx.db.prepare(
    `SELECT MIN(w_avg) AS w FROM power_rollup WHERE resolution = ? AND bucket >= ? AND bucket < ?`,
  );
  const metricsRowsStmt = ctx.db.prepare(
    'SELECT day, always_on_w AS w FROM daily_metrics WHERE always_on_w IS NOT NULL AND day >= ?',
  );
  const deviceIdsStmt = ctx.db.prepare('SELECT id, name FROM devices WHERE revoked = 0');
  const deviceDailyStmt = ctx.db.prepare(
    'SELECT day, kwh FROM device_daily WHERE device_id = ? AND day >= ?',
  );
  const bucketsStmt = ctx.db.prepare(
    'SELECT DISTINCT bucket FROM power_rollup WHERE resolution = 30 AND bucket >= ? AND bucket < ? ORDER BY bucket',
  );
  const upsertOutageStmt = ctx.db.prepare(
    `INSERT INTO outages (started_ts, ended_ts) VALUES (?, ?)
     ON CONFLICT(started_ts) DO UPDATE SET ended_ts = MAX(ended_ts, excluded.ended_ts)`,
  );

  // Always-on floor per day (yesterday finalized + today's running value).
  scheduler.register(
    'daily-metrics',
    60 * 60_000,
    async () => {
      const today = todayLocal(tz());
      for (const day of [addDays(today, -1), today]) {
        const start = localDayStartTs(day, tz());
        const end = localDayStartTs(addDays(day, 1), tz());
        let row = minAvgStmt.get(30, start, end) as { w: number | null };
        if (row.w === null) row = minAvgStmt.get(300, start, end) as { w: number | null };
        if (row.w !== null) upsertMetricsStmt.run(day, row.w);
      }
    },
    { runImmediately: true },
  );

  // Optional weather backfill (Open-Meteo, keyless) for degree-day analytics.
  if (ctx.config.lat && ctx.config.lon) {
    scheduler.register('weather', 6 * 3600_000, async () => {
      const today = todayLocal(tz());
      const missing = missingWeatherStmt.all(addDays(today, -60), today) as {
        day: string;
      }[];
      if (missing.length === 0) return;
      const first = missing[0]!.day;
      const last = missing[missing.length - 1]!.day;
      const url =
        `https://archive-api.open-meteo.com/v1/archive?latitude=${ctx.config.lat}&longitude=${ctx.config.lon}` +
        `&start_date=${first}&end_date=${last}&daily=temperature_2m_mean&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
      const data = (await res.json()) as {
        daily?: { time: string[]; temperature_2m_mean: (number | null)[] };
      };
      if (!data.daily) return;
      const wanted = new Set(missing.map((m) => m.day));
      for (let i = 0; i < data.daily.time.length; i++) {
        const day = data.daily.time[i]!;
        const t = data.daily.temperature_2m_mean[i];
        if (!wanted.has(day) || t === null || t === undefined) continue;
        setWeatherStmt.run(day, Math.max(0, 18 - t), Math.max(0, t - 18));
      }
    });
  }

  // Device anomaly baselines + always-on creep, refreshed every 6h.
  scheduler.register(
    'anomalies',
    6 * 3600_000,
    async () => {
      const today = todayLocal(tz());
      const now = Math.floor(Date.now() / 1000);
      const since = addDays(today, -100);

      const anomalies: Record<string, DeviceAnomalyInfo> = {};
      const devices = deviceIdsStmt.all() as { id: string; name: string }[];
      for (const d of devices) {
        const rows = deviceDailyStmt.all(d.id, since) as {
          day: string;
          kwh: number;
        }[];
        const result = computeDeviceAnomaly(rows, today);
        if (!result) continue;
        anomalies[d.id] = result;
        const notifiedKey = `${ANOMALY_NOTIFIED_PREFIX}${d.id}`;
        const lastNotified = Number(ctx.kv.get(notifiedKey) ?? '0');
        if (now - lastNotified > NOTIFY_COOLDOWN_S) {
          ctx.kv.set(notifiedKey, String(now));
          emitEvent(ctx, {
            type: 'anomaly.device',
            ts: now,
            deviceId: d.id,
            name: d.name,
            pct: result.pct,
            direction: result.direction,
          });
        }
      }
      ctx.kv.setJson(ANOMALIES_KEY, anomalies);

      const metricRows = metricsRowsStmt.all(since) as {
        day: string;
        w: number;
      }[];
      const creep = computeAlwaysOnCreep(metricRows, today);
      if (creep) {
        ctx.kv.setJson(CREEP_KEY, creep);
        const lastNotified = Number(ctx.kv.get(CREEP_NOTIFIED_KEY) ?? '0');
        if (now - lastNotified > NOTIFY_COOLDOWN_S) {
          ctx.kv.set(CREEP_NOTIFIED_KEY, String(now));
          emitEvent(ctx, {
            type: 'alwayson.creep',
            ts: now,
            currentW: creep.currentW,
            baselineW: creep.baselineW,
          });
        }
      } else {
        ctx.kv.delete(CREEP_KEY);
      }
    },
    { runImmediately: true },
  );

  // Outage scan: internal gaps in the 30s archive over a rolling window.
  scheduler.register(
    'outages',
    15 * 60_000,
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const scanStart = now - 48 * 3600;
      const scanEnd = now - 600; // ignore the live edge
      const buckets = (bucketsStmt.all(scanStart, scanEnd) as { bucket: number }[]).map(
        (r) => r.bucket,
      );
      for (const gap of findGaps(buckets, 30, 300)) {
        upsertOutageStmt.run(gap.startTs, gap.endTs);
      }
    },
    { runImmediately: true },
  );
}
