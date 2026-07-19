import { describe, expect, it } from 'vitest';
import { addDays } from '../lib/time.js';
import { computeAlwaysOnCreep, computeDeviceAnomaly, findGaps } from './analytics.js';

const TODAY = '2026-04-10';
const RECENT_START = addDays(TODAY, -7); // default recentDays window start
const BASELINE_START = addDays(RECENT_START, -90); // default baselineDays window start

function daysRange(start: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

function kwhRows(days: string[], kwh: number): { day: string; kwh: number }[] {
  return days.map((day) => ({ day, kwh }));
}

function wRows(days: string[], w: number): { day: string; w: number }[] {
  return days.map((day) => ({ day, w }));
}

describe('computeDeviceAnomaly', () => {
  it('detects a clear 50% increase', () => {
    const baseline = kwhRows(daysRange(BASELINE_START, 60), 1.0);
    const recent = kwhRows(daysRange(RECENT_START, 7), 1.5);
    const result = computeDeviceAnomaly([...baseline, ...recent], TODAY);
    expect(result).not.toBeNull();
    expect(result!.pct).toBeCloseTo(0.5, 10);
    expect(result!.direction).toBe('up');
    expect(result!.baselineKwhPerDay).toBeCloseTo(1.0, 10);
    expect(result!.recentKwhPerDay).toBeCloseTo(1.5, 10);
  });

  it('detects a symmetric decrease', () => {
    const baseline = kwhRows(daysRange(BASELINE_START, 60), 1.0);
    const recent = kwhRows(daysRange(RECENT_START, 7), 0.5);
    const result = computeDeviceAnomaly([...baseline, ...recent], TODAY);
    expect(result).not.toBeNull();
    expect(result!.pct).toBeCloseTo(-0.5, 10);
    expect(result!.direction).toBe('down');
  });

  it('returns null when below the pct threshold', () => {
    const baseline = kwhRows(daysRange(BASELINE_START, 60), 1.0);
    const recent = kwhRows(daysRange(RECENT_START, 7), 1.2); // +20%, threshold is 30%
    const result = computeDeviceAnomaly([...baseline, ...recent], TODAY);
    expect(result).toBeNull();
  });

  it('returns null when below the absolute threshold despite a large pct', () => {
    const baseline = kwhRows(daysRange(BASELINE_START, 60), 0.1);
    const recent = kwhRows(daysRange(RECENT_START, 7), 0.15); // +50% but only +0.05 kWh
    const result = computeDeviceAnomaly([...baseline, ...recent], TODAY);
    expect(result).toBeNull();
  });

  it('returns null when baseline has insufficient samples', () => {
    const baseline = kwhRows(daysRange(BASELINE_START, 20), 1.0); // < minBaselineSamples (30)
    const recent = kwhRows(daysRange(RECENT_START, 7), 1.5);
    const result = computeDeviceAnomaly([...baseline, ...recent], TODAY);
    expect(result).toBeNull();
  });

  it('returns null when recent has insufficient samples', () => {
    const baseline = kwhRows(daysRange(BASELINE_START, 60), 1.0);
    const recent = kwhRows(daysRange(RECENT_START, 3), 1.5); // < minRecentSamples (5)
    const result = computeDeviceAnomaly([...baseline, ...recent], TODAY);
    expect(result).toBeNull();
  });

  it('returns null when the baseline mean is too tiny to compare', () => {
    const baseline = kwhRows(daysRange(BASELINE_START, 60), 0.03); // < 0.05 kWh/day
    const recent = kwhRows(daysRange(RECENT_START, 7), 0.1);
    const result = computeDeviceAnomaly([...baseline, ...recent], TODAY);
    expect(result).toBeNull();
  });

  it('handles unordered input identically to ordered input', () => {
    const baseline = kwhRows(daysRange(BASELINE_START, 60), 1.0);
    const recent = kwhRows(daysRange(RECENT_START, 7), 1.5);
    const shuffled = [...recent, ...baseline].reverse();
    const result = computeDeviceAnomaly(shuffled, TODAY);
    expect(result).not.toBeNull();
    expect(result!.pct).toBeCloseTo(0.5, 10);
    expect(result!.direction).toBe('up');
  });

  it('excludes today itself from the recent window', () => {
    const baseline = kwhRows(daysRange(BASELINE_START, 60), 1.0);
    const recent = kwhRows(daysRange(RECENT_START, 7), 1.5);
    const withTodayPollution = [...baseline, ...recent, { day: TODAY, kwh: 999999 }];
    const result = computeDeviceAnomaly(withTodayPollution, TODAY);
    expect(result).not.toBeNull();
    expect(result!.pct).toBeCloseTo(0.5, 10);
    expect(result!.recentKwhPerDay).toBeCloseTo(1.5, 10);
  });
});

describe('computeAlwaysOnCreep', () => {
  it('detects creep: baseline median 200W, recent mean 250W -> pct 0.25', () => {
    const baseline = wRows(daysRange(BASELINE_START, 90), 200);
    const recent = wRows(daysRange(RECENT_START, 7), 250);
    const result = computeAlwaysOnCreep([...baseline, ...recent], TODAY);
    expect(result).not.toBeNull();
    expect(result!.baselineW).toBeCloseTo(200, 10);
    expect(result!.currentW).toBeCloseTo(250, 10);
    expect(result!.pct).toBeCloseTo(0.25, 10);
  });

  it('is robust to outliers via median (mean would hide/skew the signal)', () => {
    const normalDays = daysRange(BASELINE_START, 85);
    const outlierDays = daysRange(addDays(BASELINE_START, 85), 5);
    const baseline = [...wRows(normalDays, 200), ...wRows(outlierDays, 800)];
    // Mean baseline would be (85*200 + 5*800)/90 = 233.33, under which a
    // recent mean of 250W would NOT trip the 1.2x threshold (250 < 280).
    // The median stays ~200, so creep IS detected.
    const recent = wRows(daysRange(RECENT_START, 7), 250);
    const result = computeAlwaysOnCreep([...baseline, ...recent], TODAY);
    expect(result).not.toBeNull();
    expect(result!.baselineW).toBeCloseTo(200, 10);
  });

  it('returns null when below the 20% threshold', () => {
    const baseline = wRows(daysRange(BASELINE_START, 90), 200);
    const recent = wRows(daysRange(RECENT_START, 7), 220); // +10%
    const result = computeAlwaysOnCreep([...baseline, ...recent], TODAY);
    expect(result).toBeNull();
  });

  it('returns null when above 20% but the absolute delta is <= 15W', () => {
    const baseline = wRows(daysRange(BASELINE_START, 90), 60);
    const recent = wRows(daysRange(RECENT_START, 7), 74); // +23.3%, delta only 14W
    const result = computeAlwaysOnCreep([...baseline, ...recent], TODAY);
    expect(result).toBeNull();
  });

  it('returns null when there are insufficient samples', () => {
    const baseline = wRows(daysRange(BASELINE_START, 10), 200); // < 30
    const recent = wRows(daysRange(RECENT_START, 7), 250);
    const result = computeAlwaysOnCreep([...baseline, ...recent], TODAY);
    expect(result).toBeNull();
  });
});

describe('findGaps', () => {
  it('returns no gaps for continuous buckets', () => {
    expect(findGaps([0, 30, 60, 90], 30, 300)).toEqual([]);
  });

  it('finds a single gap for a 10-minute hole in 30s buckets', () => {
    // buckets at 0,30,60 then a jump straight to 690 (skipping 90..660).
    const buckets = [0, 30, 60, 690, 720];
    const gaps = findGaps(buckets, 30, 300);
    expect(gaps).toEqual([{ startTs: 90, endTs: 690 }]);
  });

  it('ignores a gap below minGapS', () => {
    const buckets = [0, 30, 90]; // missing bucket at 60 -> only a 30s hole
    expect(findGaps(buckets, 30, 300)).toEqual([]);
  });

  it('ignores duplicate buckets', () => {
    expect(findGaps([0, 30, 30, 60], 30, 300)).toEqual([]);
    // duplicates interleaved with a real gap still find exactly one gap
    expect(findGaps([0, 30, 30, 690], 30, 300)).toEqual([{ startTs: 60, endTs: 690 }]);
  });

  it('returns [] for empty or single-bucket input', () => {
    expect(findGaps([], 30, 300)).toEqual([]);
    expect(findGaps([0], 30, 300)).toEqual([]);
  });
});
