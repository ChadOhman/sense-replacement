import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import type { Scheduler } from './scheduler.js';

const COMPACT_30_AGE_S = 3600; // 30s rows older than 1h are compacted to 300s
const COMPACT_300_AGE_S = 86400; // 300s rows older than 1 day are compacted to 3600s
const RETAIN_30_S = 7 * 86400;
const RETAIN_300_S = 2 * 365 * 86400;

/** Compact fine rollups into coarser buckets (weighted by sample_count).
 *  Only fully-elapsed target buckets are written; INSERT OR IGNORE makes
 *  re-runs idempotent. Exported with (db, now) for unit testing. */
function compact(db: Db, from: number, to: number, ageS: number, now: number): void {
  const cutoff = now - ageS;
  db.prepare(
    `INSERT OR IGNORE INTO power_rollup (resolution, bucket, w_avg, w_min, w_max, volts, hz, sample_count, solar_w_avg)
     SELECT ${to}, (bucket / ${to}) * ${to} AS b,
       SUM(w_avg * sample_count) / SUM(sample_count),
       MIN(w_min), MAX(w_max),
       SUM(COALESCE(volts, 0) * sample_count) / NULLIF(SUM(CASE WHEN volts IS NOT NULL THEN sample_count ELSE 0 END), 0),
       SUM(COALESCE(hz, 0) * sample_count) / NULLIF(SUM(CASE WHEN hz IS NOT NULL THEN sample_count ELSE 0 END), 0),
       SUM(sample_count),
       SUM(COALESCE(solar_w_avg, 0) * sample_count) / NULLIF(SUM(CASE WHEN solar_w_avg IS NOT NULL THEN sample_count ELSE 0 END), 0)
     FROM power_rollup
     WHERE resolution = ${from} AND bucket < ? AND (bucket / ${to}) * ${to} + ${to} <= ?
     GROUP BY b`,
  ).run(cutoff, cutoff);

  db.prepare(
    `INSERT OR IGNORE INTO device_power_rollup (resolution, bucket, device_id, w_avg, sample_count)
     SELECT ${to}, (bucket / ${to}) * ${to} AS b, device_id,
       SUM(w_avg * sample_count) / SUM(sample_count),
       SUM(sample_count)
     FROM device_power_rollup
     WHERE resolution = ${from} AND bucket < ? AND (bucket / ${to}) * ${to} + ${to} <= ?
     GROUP BY b, device_id`,
  ).run(cutoff, cutoff);

  db.prepare(
    `INSERT OR IGNORE INTO voltage_rollup (resolution, bucket, leg, v_avg, v_min, v_max, sample_count)
     SELECT ${to}, (bucket / ${to}) * ${to} AS b, leg,
       SUM(v_avg * sample_count) / SUM(sample_count),
       MIN(v_min), MAX(v_max),
       SUM(sample_count)
     FROM voltage_rollup
     WHERE resolution = ${from} AND bucket < ? AND (bucket / ${to}) * ${to} + ${to} <= ?
     GROUP BY b, leg`,
  ).run(cutoff, cutoff);
}

export function compact30to300(db: Db, now: number): void {
  compact(db, 30, 300, COMPACT_30_AGE_S, now);
}

export function compact300to3600(db: Db, now: number): void {
  compact(db, 300, 3600, COMPACT_300_AGE_S, now);
}

const RETAIN_NILM_UNLABELED_S = 90 * 86400;

/** Old NILM events whose cluster never got a device label (or no cluster at
 *  all) are noise; labeled clusters keep their events for the UI's history.
 *  Cluster profiles are stored on the cluster row, so pruning members never
 *  degrades matching. */
export function pruneOldNilmEvents(db: Db, now: number): void {
  db.prepare(
    `DELETE FROM nilm_events WHERE ts < ? AND (
       cluster_id IS NULL
       OR cluster_id IN (SELECT id FROM nilm_clusters WHERE device_id IS NULL)
     )`,
  ).run(now - RETAIN_NILM_UNLABELED_S);
}

export function pruneOldRollups(db: Db, now: number): void {
  // Safe without a compaction-completeness join: compaction runs every 5 min
  // and covers rows after 1h/1d, while deletion cutoffs are 7d/2y — every row
  // deleted here was compacted long ago.
  db.prepare('DELETE FROM power_rollup WHERE resolution = 30 AND bucket < ?').run(now - RETAIN_30_S);
  db.prepare('DELETE FROM device_power_rollup WHERE resolution = 30 AND bucket < ?').run(now - RETAIN_30_S);
  db.prepare('DELETE FROM voltage_rollup WHERE resolution = 30 AND bucket < ?').run(now - RETAIN_30_S);
  db.prepare('DELETE FROM power_rollup WHERE resolution = 300 AND bucket < ?').run(now - RETAIN_300_S);
  db.prepare('DELETE FROM device_power_rollup WHERE resolution = 300 AND bucket < ?').run(now - RETAIN_300_S);
  db.prepare('DELETE FROM voltage_rollup WHERE resolution = 300 AND bucket < ?').run(now - RETAIN_300_S);
}

export function registerRetentionJob(ctx: AppContext, scheduler: Scheduler): void {
  scheduler.register('retention', 5 * 60_000, async () => {
    const now = Math.floor(Date.now() / 1000);
    compact30to300(ctx.db, now);
    compact300to3600(ctx.db, now);
    pruneOldRollups(ctx.db, now);
    pruneOldNilmEvents(ctx.db, now);
    ctx.db.pragma('incremental_vacuum(200)');
  });
}
