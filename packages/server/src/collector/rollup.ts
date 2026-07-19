import type { LiveFrame } from '@sense/shared';

/** Pure aggregation helpers for the rollup pipeline. No I/O here. */

export interface FrameAggregate {
  wAvg: number;
  wMin: number;
  wMax: number;
  /** Average solar production over frames reporting it; null without solar. */
  solarWAvg: number | null;
  volts: number | null;
  hz: number | null;
  sampleCount: number;
  /** Per-device average over ALL frames in the bucket (absent = 0 W). */
  perDevice: Map<string, { wAvg: number }>;
}

export function aggregateFrames(frames: LiveFrame[]): FrameAggregate | null {
  if (frames.length === 0) return null;
  let wSum = 0;
  let wMin = Infinity;
  let wMax = -Infinity;
  let voltsSum = 0;
  let voltsN = 0;
  let hzSum = 0;
  let hzN = 0;
  let solarSum = 0;
  let solarN = 0;
  const perDeviceSum = new Map<string, number>();
  for (const f of frames) {
    wSum += f.w;
    if (f.w < wMin) wMin = f.w;
    if (f.w > wMax) wMax = f.w;
    if (f.volts !== null) {
      voltsSum += f.volts;
      voltsN++;
    }
    if (f.hz !== null) {
      hzSum += f.hz;
      hzN++;
    }
    if (f.solarW !== null) {
      solarSum += f.solarW;
      solarN++;
    }
    for (const d of f.devices) {
      perDeviceSum.set(d.id, (perDeviceSum.get(d.id) ?? 0) + d.w);
    }
  }
  // Archival honesty: a device absent from a frame contributes 0 W, so its
  // bucket average divides by the total frame count, not its presence count.
  const perDevice = new Map<string, { wAvg: number }>();
  for (const [id, sum] of perDeviceSum) perDevice.set(id, { wAvg: sum / frames.length });
  return {
    wAvg: wSum / frames.length,
    wMin,
    wMax,
    solarWAvg: solarN > 0 ? solarSum / solarN : null,
    volts: voltsN > 0 ? voltsSum / voltsN : null,
    hz: hzN > 0 ? hzSum / hzN : null,
    sampleCount: frames.length,
    perDevice,
  };
}

export interface LegVoltageAggregate {
  vAvg: number;
  vMin: number;
  vMax: number;
  sampleCount: number;
}

/** Per-leg voltage aggregation over a bucket. A leg is averaged only over the
 *  frames in which it was reported (missing readings are gaps, not zeros). */
export function aggregateLegVoltages(frames: readonly LiveFrame[]): Map<number, LegVoltageAggregate> {
  const legs = new Map<number, { sum: number; min: number; max: number; n: number }>();
  for (const f of frames) {
    for (let i = 0; i < f.voltageLegs.length; i++) {
      const v = f.voltageLegs[i]!;
      if (v <= 20) continue; // meter glitch, same floor as the detectors
      const s = legs.get(i);
      if (s) {
        s.sum += v;
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
        s.n += 1;
      } else {
        legs.set(i, { sum: v, min: v, max: v, n: 1 });
      }
    }
  }
  const out = new Map<number, LegVoltageAggregate>();
  for (const [leg, s] of legs) {
    out.set(leg, { vAvg: s.sum / s.n, vMin: s.min, vMax: s.max, sampleCount: s.n });
  }
  return out;
}

/** Aligned floor of ts to the given resolution (seconds). */
export function bucketStart(ts: number, resolution: number): number {
  return Math.floor(ts / resolution) * resolution;
}

/** Choose the rollup resolution for a query range: <=2 days -> 30s,
 *  <=60 days -> 300s, else 3600s. */
export function pickResolution(fromTs: number, toTs: number): 30 | 300 | 3600 {
  const rangeSeconds = toTs - fromTs;
  if (rangeSeconds <= 2 * 86400) return 30;
  if (rangeSeconds <= 60 * 86400) return 300;
  return 3600;
}
