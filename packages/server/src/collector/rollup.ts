import type { LiveFrame } from '@sense/shared';

/** Pure aggregation helpers for the rollup pipeline. No I/O here. */

export interface FrameAggregate {
  wAvg: number;
  wMin: number;
  wMax: number;
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
    volts: voltsN > 0 ? voltsSum / voltsN : null,
    hz: hzN > 0 ? hzSum / hzN : null,
    sampleCount: frames.length,
    perDevice,
  };
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
