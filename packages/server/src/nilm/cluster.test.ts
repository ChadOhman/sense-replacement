import { describe, expect, it } from 'vitest';
import { clusterPass, type ClusterRow, type EventRow } from './cluster.js';
import { smooth2 } from './kmeans.js';

let nextId = 1;

/** Event with a step of `magnitude` at sample 0 (20 raw samples). */
function stepEvent(magnitude: number, direction: 'on' | 'off' = 'on', jitter = 0): EventRow {
  const sign = direction === 'on' ? 1 : -1;
  return {
    id: nextId++,
    direction,
    waveform: Array.from({ length: 20 }, (_, i) => (i === 0 ? sign * magnitude + jitter : jitter)),
  };
}

function profileFor(magnitude: number, direction: 'on' | 'off' = 'on'): number[] {
  return smooth2(stepEvent(magnitude, direction).waveform);
}

describe('clusterPass', () => {
  it('absorbs events into an existing cluster within its radius', () => {
    const existing: ClusterRow[] = [
      { id: 10, direction: 'on', profile: profileFor(1000), radius: 100, size: 5 },
    ];
    const events = [stepEvent(1000, 'on', 1), stepEvent(1010, 'on', 2)];
    const result = clusterPass(existing, events, 200);
    expect(result.assignments.map((a) => a.clusterId)).toEqual([10, 10]);
    expect(result.updatedSizes).toEqual([{ clusterId: 10, size: 7 }]);
    expect(result.newClusters).toEqual([]);
  });

  it('does not absorb across directions or beyond the radius', () => {
    const existing: ClusterRow[] = [
      { id: 10, direction: 'on', profile: profileFor(1000), radius: 100, size: 5 },
    ];
    const offEvent = stepEvent(1000, 'off');
    const farEvent = stepEvent(5000, 'on');
    const result = clusterPass(existing, [offEvent, farEvent], 200);
    expect(result.assignments).toEqual([]);
    // two lone leftovers (one per direction) are below the min cluster size
    expect(result.newClusters).toEqual([]);
  });

  it('discovers new clusters from the leftovers, per direction', () => {
    const events = [
      ...Array.from({ length: 4 }, (_, i) => stepEvent(1200, 'on', i)),
      ...Array.from({ length: 4 }, (_, i) => stepEvent(4800, 'on', i)),
      ...Array.from({ length: 3 }, (_, i) => stepEvent(1200, 'off', i)),
    ];
    const result = clusterPass([], events, 200);
    expect(result.newClusters).toHaveLength(3);
    const on = result.newClusters.filter((c) => c.direction === 'on');
    const off = result.newClusters.filter((c) => c.direction === 'off');
    expect(on).toHaveLength(2);
    expect(off).toHaveLength(1);
    for (const c of result.newClusters) {
      expect(c.size).toBe(c.eventIds.length);
      expect(c.radius).toBeGreaterThan(0); // radius floor keeps tight clusters matchable
    }
  });

  it('leaves existing profiles untouched (labels survive re-clustering)', () => {
    const profile = profileFor(1000);
    const existing: ClusterRow[] = [
      { id: 10, direction: 'on', profile, radius: 50, size: 5 },
    ];
    const events = Array.from({ length: 5 }, (_, i) => stepEvent(3000, 'on', i));
    const result = clusterPass(existing, events, 200);
    // the pass only ever grows sizes or adds new clusters — no profile edits
    expect(result.updatedSizes).toEqual([]);
    expect(result.newClusters).toHaveLength(1);
    expect(existing[0]!.profile).toBe(profile);
  });

  it('groups smaller than the minimum stay unclustered', () => {
    const events = [stepEvent(700, 'on', 0), stepEvent(700, 'on', 1)];
    const result = clusterPass([], events, 200);
    expect(result.newClusters).toEqual([]);
  });
});
