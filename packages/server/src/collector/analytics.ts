import { addDays } from '../lib/time.js';

/** Pure health-analytics math for anomaly/creep detection and gap discovery.
 *  No I/O, no Date.now — callers supply `today` (local day string) and raw
 *  rollup rows. */

export interface AnomalyOptions {
  baselineDays?: number; // default 90 — window ending where the recent window starts
  recentDays?: number; // default 7
  minBaselineSamples?: number; // default 30 — data days required in baseline
  minRecentSamples?: number; // default 5
  pctThreshold?: number; // default 0.3  (30%)
  absThresholdKwh?: number; // default 0.2  kWh/day
}

export interface DeviceAnomaly {
  pct: number; // signed: +0.35 = 35% above baseline
  direction: 'up' | 'down';
  recentKwhPerDay: number;
  baselineKwhPerDay: number;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Compare trailing-7d mean daily kWh vs the preceding 90d mean.
 *  rows: {day: 'YYYY-MM-DD', kwh}[] in ANY order; today: current local day
 *  (recent window = [addDays(today,-recentDays), today) — today itself
 *  excluded, it's incomplete). Missing days are simply absent (device off
 *  that day = row may be absent; treat absent as no sample, NOT zero — but
 *  if fewer than min sample counts, return null). Return null when below
 *  sample minimums, when baseline mean is < 0.05 kWh/day (too small to
 *  compare meaningfully), or when thresholds aren't exceeded. */
export function computeDeviceAnomaly(
  rows: { day: string; kwh: number }[],
  today: string,
  opts?: AnomalyOptions,
): DeviceAnomaly | null {
  const baselineDays = opts?.baselineDays ?? 90;
  const recentDays = opts?.recentDays ?? 7;
  const minBaselineSamples = opts?.minBaselineSamples ?? 30;
  const minRecentSamples = opts?.minRecentSamples ?? 5;
  const pctThreshold = opts?.pctThreshold ?? 0.3;
  const absThresholdKwh = opts?.absThresholdKwh ?? 0.2;

  const recentStart = addDays(today, -recentDays);
  const baselineStart = addDays(recentStart, -baselineDays);

  const recent: number[] = [];
  const baseline: number[] = [];
  for (const row of rows) {
    if (row.day >= recentStart && row.day < today) {
      recent.push(row.kwh);
    } else if (row.day >= baselineStart && row.day < recentStart) {
      baseline.push(row.kwh);
    }
  }

  if (baseline.length < minBaselineSamples || recent.length < minRecentSamples) return null;

  const baselineKwhPerDay = mean(baseline);
  if (baselineKwhPerDay < 0.05) return null;

  const recentKwhPerDay = mean(recent);
  const pct = (recentKwhPerDay - baselineKwhPerDay) / baselineKwhPerDay;

  if (Math.abs(pct) < pctThreshold) return null;
  if (Math.abs(recentKwhPerDay - baselineKwhPerDay) < absThresholdKwh) return null;

  return {
    pct,
    direction: pct >= 0 ? 'up' : 'down',
    recentKwhPerDay,
    baselineKwhPerDay,
  };
}

export interface CreepResult {
  currentW: number; // recent 7d mean of daily always-on watts
  baselineW: number; // median of the preceding 90d
  pct: number; // (current - baseline) / baseline, signed
}

const CREEP_BASELINE_DAYS = 90;
const CREEP_RECENT_DAYS = 7;
const CREEP_MIN_BASELINE_SAMPLES = 30;
const CREEP_MIN_RECENT_SAMPLES = 5;
const CREEP_PCT_THRESHOLD = 1.2;
const CREEP_ABS_THRESHOLD_W = 15;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2;
  return sorted[mid]!;
}

/** Always-on creep: recent-7d mean vs preceding-90d MEDIAN (median so a few
 *  bad days can't drag the baseline). rows: {day, w}. Same day-window logic
 *  as above. Return the CreepResult ONLY when current > baseline * 1.2 AND
 *  current - baseline > 15 W; else null. Require >= 30 baseline samples and
 *  >= 5 recent samples. */
export function computeAlwaysOnCreep(rows: { day: string; w: number }[], today: string): CreepResult | null {
  const recentStart = addDays(today, -CREEP_RECENT_DAYS);
  const baselineStart = addDays(recentStart, -CREEP_BASELINE_DAYS);

  const recent: number[] = [];
  const baseline: number[] = [];
  for (const row of rows) {
    if (row.day >= recentStart && row.day < today) {
      recent.push(row.w);
    } else if (row.day >= baselineStart && row.day < recentStart) {
      baseline.push(row.w);
    }
  }

  if (baseline.length < CREEP_MIN_BASELINE_SAMPLES || recent.length < CREEP_MIN_RECENT_SAMPLES) return null;

  const currentW = mean(recent);
  const baselineW = median(baseline);

  if (!(currentW > baselineW * CREEP_PCT_THRESHOLD && currentW - baselineW > CREEP_ABS_THRESHOLD_W)) return null;

  return {
    currentW,
    baselineW,
    pct: (currentW - baselineW) / baselineW,
  };
}

export interface Gap {
  startTs: number;
  endTs: number;
}

/** Find internal gaps in a sorted-ascending list of rollup bucket start
 *  timestamps of fixed resolution (seconds). A gap exists between bucket b
 *  and next bucket n when n - (b + resolution) >= minGapS; the gap is
 *  [b + resolution, n]. Buckets may contain duplicates (ignore). Empty or
 *  single-bucket input → []. Input must already be sorted ascending. */
export function findGaps(buckets: number[], resolution: number, minGapS: number): Gap[] {
  const gaps: Gap[] = [];
  if (buckets.length < 2) return gaps;

  let prev = buckets[0]!;
  for (let i = 1; i < buckets.length; i++) {
    const cur = buckets[i]!;
    if (cur === prev) continue; // duplicate bucket, ignore
    const gapSize = cur - (prev + resolution);
    if (gapSize >= minGapS) {
      gaps.push({ startTs: prev + resolution, endTs: cur });
    }
    prev = cur;
  }
  return gaps;
}
