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

  constructor(private readonly ctx: CostCtx) {
    this.hourlyStmt = this.ctx.db.prepare(
      `SELECT bucket, w_avg AS wAvg, sample_count AS n FROM power_rollup
       WHERE resolution = ? AND bucket >= ? AND bucket < ?`,
    );
    this.dailyKwhStmt = this.ctx.db.prepare(
      'SELECT COALESCE(SUM(kwh), 0) AS kwh FROM daily_summary WHERE day = ?',
    );
  }

  invalidate(): void {
    this.cache.clear();
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
   *  used for per-device costs, which have no hourly profile of their own. */
  costForKwhOnDay(kwh: number, day: string): number {
    const { ratePlan } = getBillingSettings(this.ctx);
    const month = Number(day.slice(5, 7));
    return (kwh * blendedRateCents(ratePlan, month)) / 100;
  }
}
