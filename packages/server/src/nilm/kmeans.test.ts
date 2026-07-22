import { describe, expect, it } from 'vitest';
import { chooseK, euclidean, kmeans, medianWaveform, smooth2 } from './kmeans.js';

/** A synthetic waveform: a step of `magnitude` at index 0, flat after. */
function stepWave(magnitude: number, jitter = 0): number[] {
  return Array.from({ length: 19 }, (_, i) => (i === 0 ? magnitude + jitter : jitter));
}

describe('vector helpers', () => {
  it('euclidean distance', () => {
    expect(euclidean([0, 0], [3, 4])).toBe(5);
  });

  it('smooth2 averages adjacent samples', () => {
    expect(smooth2([100, 300, 300])).toEqual([200, 300]);
  });

  it('medianWaveform is robust to one outlier member', () => {
    const median = medianWaveform([
      [100, 0],
      [100, 0],
      [9000, 500],
    ]);
    expect(median).toEqual([100, 0]);
  });
});

describe('kmeans', () => {
  it('is deterministic for a fixed seed', () => {
    const points = [stepWave(100), stepWave(105), stepWave(2000), stepWave(2010)];
    const a = kmeans(points, 2, 42);
    const b = kmeans(points, 2, 42);
    expect(a.assignments).toEqual(b.assignments);
  });

  it('separates two well-spaced waveform families', () => {
    const points = [
      ...Array.from({ length: 5 }, (_, i) => stepWave(100, i)),
      ...Array.from({ length: 5 }, (_, i) => stepWave(2000, i)),
    ];
    const { assignments } = kmeans(points, 2, 7);
    const low = new Set(assignments.slice(0, 5));
    const high = new Set(assignments.slice(5));
    expect(low.size).toBe(1);
    expect(high.size).toBe(1);
    expect([...low][0]).not.toBe([...high][0]);
  });
});

describe('chooseK', () => {
  it('finds one cluster per distinct family', () => {
    const points = [
      ...Array.from({ length: 6 }, (_, i) => stepWave(100, i)),
      ...Array.from({ length: 6 }, (_, i) => stepWave(1500, i)),
      ...Array.from({ length: 6 }, (_, i) => stepWave(4000, i)),
    ];
    const { assignments } = chooseK(points, 200, 7);
    expect(new Set(assignments).size).toBe(3);
  });

  it('stops splitting when profiles would get closer than splitDistance', () => {
    // Two families only 100 W apart: with splitDistance 200 they must merge.
    const points = [
      ...Array.from({ length: 6 }, (_, i) => stepWave(1000, i)),
      ...Array.from({ length: 6 }, (_, i) => stepWave(1100, i)),
    ];
    const { assignments } = chooseK(points, 200, 7);
    expect(new Set(assignments).size).toBe(1);
  });

  it('handles the empty and singleton cases', () => {
    expect(chooseK([], 200, 1).assignments).toEqual([]);
    expect(chooseK([stepWave(500)], 200, 1).assignments).toEqual([0]);
  });
});
