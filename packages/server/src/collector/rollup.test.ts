import { describe, expect, it } from 'vitest';
import type { LiveFrame } from '@sense/shared';
import { aggregateFrames, bucketStart, pickResolution } from './rollup.js';

function frame(ts: number, w: number, devices: { id: string; w: number }[] = [], volts: number | null = 120, hz: number | null = 60): LiveFrame {
  return {
    ts,
    w,
    volts,
    hz,
    devices: devices.map((d) => ({ id: d.id, name: d.id, icon: null, w: d.w })),
  };
}

describe('aggregateFrames', () => {
  it('returns null for no frames', () => {
    expect(aggregateFrames([])).toBeNull();
  });

  it('aggregates a single frame', () => {
    const agg = aggregateFrames([frame(0, 500, [{ id: 'x', w: 100 }])]);
    expect(agg).not.toBeNull();
    expect(agg!.wAvg).toBe(500);
    expect(agg!.wMin).toBe(500);
    expect(agg!.wMax).toBe(500);
    expect(agg!.sampleCount).toBe(1);
    expect(agg!.perDevice.get('x')!.wAvg).toBe(100);
  });

  it('computes min/max/avg across frames', () => {
    const agg = aggregateFrames([frame(0, 100), frame(1, 300), frame(2, 200)]);
    expect(agg!.wAvg).toBe(200);
    expect(agg!.wMin).toBe(100);
    expect(agg!.wMax).toBe(300);
  });

  it('treats device absence as 0 W in per-device average', () => {
    const agg = aggregateFrames([frame(0, 100, [{ id: 'x', w: 100 }]), frame(1, 0, [])]);
    expect(agg!.perDevice.get('x')!.wAvg).toBe(50);
  });

  it('excludes null volts/hz from averages and returns null when all null', () => {
    const agg = aggregateFrames([frame(0, 100, [], 120, null), frame(1, 100, [], null, null)]);
    expect(agg!.volts).toBe(120);
    expect(agg!.hz).toBeNull();
  });
});

describe('bucketStart', () => {
  it('floors to resolution', () => {
    expect(bucketStart(95, 30)).toBe(90);
    expect(bucketStart(0, 30)).toBe(0);
    expect(bucketStart(3599, 3600)).toBe(0);
  });
});

describe('pickResolution', () => {
  it('picks by range with inclusive boundaries', () => {
    expect(pickResolution(0, 2 * 86400)).toBe(30);
    expect(pickResolution(0, 2 * 86400 + 1)).toBe(300);
    expect(pickResolution(0, 60 * 86400)).toBe(300);
    expect(pickResolution(0, 60 * 86400 + 1)).toBe(3600);
  });
});
