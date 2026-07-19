import type { Db } from '../db/index.js';
import type { KvStore } from '../db/index.js';
import type { Config } from '../config.js';
import type { SenseClient } from '../sense/client.js';
import { getBillingSettings } from '../context.js';
import { addDays, localDayStartTs, todayLocal } from './time.js';
import { blendedRateCents, costForDayHourly } from './rates.js';

interface CostCtx {
  db: Db;
  kv: KvStore;
  config: Config;
  sense: SenseClient;
}

/** Rate-aware daily cost computation over the measured hourly profile, with a
 *  blended-rate fallback for days that predate our own measurements (e.g.
 *  cloud-backfilled history). Results are cached per day; completed days are
 *  immutable, today is always recomputed. */
export class CostEngine {
  private readonly cache = new Map<string, number>();
  private readonly hourlyStmt;
  private readonly dailyKwhStmt;

  private readonly deviceHourlyStmt;
  private readonly deviceDailyKwhStmt;
  private readonly deviceCache = new Map<string, number>();

  constructor(private readonly ctx: CostCtx) {
    this.hourlyStmt = this.ctx.db.prepare(
      `SELECT bucket, w_avg AS wAvg, sample_count AS n FROM power_rollup
       WHERE resolution = ? AND bucket >= ? AND bucket < ?`,
    );
    this.dailyKwhStmt = this.ctx.db.prepare(
      'SELECT COALESCE(SUM(kwh), 0) AS kwh FROM daily_summary WHERE day = ?',
    );
    this.deviceHourlyStmt = this.ctx.db.prepare(
      `SELECT bucket, w_avg AS wAvg FROM device_power_rollup
       WHERE resolution = ? AND device_id = ? AND bucket >= ? AND bucket < ?`,
    );
    this.deviceDailyKwhStmt = this.ctx.db.prepare(
      'SELECT COALESCE(SUM(kwh), 0) AS kwh FROM device_daily WHERE device_id = ? AND day = ?',
    );
  }

  invalidate(): void {
    this.cache.clear();
    this.deviceCache.clear();
  }

  private tz(): string {
    return this.ctx.sense.monitorTz ?? this.ctx.config.tz;
  }

  /** Choose one resolution per day to avoid double counting overlapping tiers:
   *  today/yesterday → 30s (complete, 7d retention); within ~2 years → 300s;
   *  older → 3600s. */
  private resolutionFor(day: string, today: string): number {
    if (day >= addDays(today, -1)) return 30;
    if (day >= addDays(today, -700)) return 300;
    return 3600;
  }

  /** Per-local-hour kWh for a day from our measured rollups. Null hour = no data. */
  private hourlyKwh(day: string): { hours: (number | null)[]; coverageS: number } {
    const tz = this.tz();
    const start = localDayStartTs(day, tz);
    const end = localDayStartTs(addDays(day, 1), tz);
    const resolution = this.resolutionFor(day, todayLocal(tz));
    const rows = this.hourlyStmt.all(resolution, start, end) as {
      bucket: number;
      wAvg: number;
      n: number;
    }[];
    const hours: (number | null)[] = Array.from({ length: 24 }, () => null);
    let coverageS = 0;
    for (const r of rows) {
      const hour = Math.min(23, Math.floor((r.bucket - start) / 3600));
      hours[hour] = (hours[hour] ?? 0) + (r.wAvg * resolution) / 3_600_000;
      coverageS += resolution;
    }
    return { hours, coverageS };
  }

  /** Cost for one local day in currency units. */
  costForDay(day: string): number {
    const tz = this.tz();
    const today = todayLocal(tz);
    if (day !== today) {
      const cached = this.cache.get(day);
      if (cached !== undefined) return cached;
    }
    const { ratePlan } = getBillingSettings(this.ctx);
    const anchor = new Date(`${day}T12:00:00Z`);
    const month = anchor.getUTCMonth() + 1;
    const weekday = anchor.getUTCDay();

    const { hours, coverageS } = this.hourlyKwh(day);
    let cost: number;
    if (coverageS >= 0.5 * 86400 || (day === today && coverageS > 0)) {
      cost = costForDayHourly(ratePlan, month, weekday, hours);
      // Top up hours we didn't measure (backfill era, or collector downtime
      // earlier today) using the trends total at the blended rate.
      if (coverageS < 0.95 * 86400) {
        const measuredKwh = hours.reduce<number>((s, h) => s + (h ?? 0), 0);
        const totalKwh = (this.dailyKwhStmt.get(day) as { kwh: number }).kwh;
        if (totalKwh > measuredKwh) {
          cost += ((totalKwh - measuredKwh) * blendedRateCents(ratePlan, month)) / 100;
        }
      }
    } else {
      const totalKwh = (this.dailyKwhStmt.get(day) as { kwh: number }).kwh;
      cost = (totalKwh * blendedRateCents(ratePlan, month)) / 100;
    }
    if (day !== today) this.cache.set(day, cost);
    return cost;
  }

  /** Cost of a kWh quantity attributed to a given day at the blended rate —
   *  fallback for quantities with no hourly profile. */
  costForKwhOnDay(kwh: number, day: string): number {
    const { ratePlan } = getBillingSettings(this.ctx);
    const month = Number(day.slice(5, 7));
    return (kwh * blendedRateCents(ratePlan, month)) / 100;
  }

  /** Cost for one device on one local day, priced against the device's own
   *  measured hourly profile (a TOU plan charges an overnight fridge less per
   *  kWh than a dinnertime oven). Falls back to the blended rate for kWh that
   *  predates or exceeds our measurements (backfill era, collector downtime). */
  costForDeviceDay(deviceId: string, day: string): number {
    const tz = this.tz();
    const today = todayLocal(tz);
    const cacheKey = `${deviceId}:${day}`;
    if (day !== today) {
      const cached = this.deviceCache.get(cacheKey);
      if (cached !== undefined) return cached;
    }
    const { ratePlan } = getBillingSettings(this.ctx);
    const anchor = new Date(`${day}T12:00:00Z`);
    const month = anchor.getUTCMonth() + 1;
    const weekday = anchor.getUTCDay();

    const start = localDayStartTs(day, tz);
    const end = localDayStartTs(addDays(day, 1), tz);
    const resolution = this.resolutionFor(day, today);
    const rows = this.deviceHourlyStmt.all(resolution, deviceId, start, end) as {
      bucket: number;
      wAvg: number;
    }[];
    const hours: (number | null)[] = Array.from({ length: 24 }, () => null);
    let measuredKwh = 0;
    for (const r of rows) {
      const hour = Math.min(23, Math.floor((r.bucket - start) / 3600));
      const kwh = (r.wAvg * resolution) / 3_600_000;
      hours[hour] = (hours[hour] ?? 0) + kwh;
      measuredKwh += kwh;
    }
    let cost = costForDayHourly(ratePlan, month, weekday, hours);
    const totalKwh = (this.deviceDailyKwhStmt.get(deviceId, day) as { kwh: number }).kwh;
    if (totalKwh > measuredKwh) {
      cost += ((totalKwh - measuredKwh) * blendedRateCents(ratePlan, month)) / 100;
    }
    if (day !== today) this.deviceCache.set(cacheKey, cost);
    return cost;
  }

  /** Sum of costForDeviceDay over [fromDay, toDay] inclusive. */
  costForDeviceRange(deviceId: string, fromDay: string, toDay: string): number {
    let cost = 0;
    for (let d = fromDay; d <= toDay; d = addDays(d, 1)) {
      cost += this.costForDeviceDay(deviceId, d);
    }
    return cost;
  }
}
