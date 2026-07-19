import { describe, expect, it } from 'vitest';
import { MotorStallDetector } from './stall.js';

describe('MotorStallDetector', () => {
  it('reports no transition for a steady load with normal small fluctuations', () => {
    const det = new MotorStallDetector();
    expect(det.sample(0, 500)).toBeNull();
    for (let i = 1; i <= 200; i++) {
      const w = 500 + (i % 2 === 0 ? 20 : -20);
      expect(det.sample(i, w)).toBeNull();
    }
    expect(det.active).toBeNull();
  });

  it('does not flag a normal appliance turn-on that stays elevated past maxSpikeDurationS', () => {
    const det = new MotorStallDetector();
    expect(det.sample(0, 500)).toBeNull();

    // +1500W step at ts=10; still elevated at ts=40 (duration 30, still a valid
    // candidate window) so no transition yet.
    expect(det.sample(10, 2000)).toBeNull();
    expect(det.sample(40, 2000)).toBeNull();
    expect(det.active).toBeNull();

    // ts=41: duration 31 > 30 -> abandoned as a normal turn-on, baseline re-seeds to 2000.
    expect(det.sample(41, 2000)).toBeNull();
    expect(det.active).toBeNull();

    // Appliance keeps running steady at the new baseline (~2000W) through ts=70 (60s
    // after the step first appeared): no further transitions, no phantom candidate.
    for (let ts = 42; ts <= 70; ts++) {
      expect(det.sample(ts, 2000 + (ts % 2 === 0 ? 10 : -10))).toBeNull();
    }
    expect(det.active).toBeNull();

    // Detector remains functional: a real spike above the new baseline still starts.
    expect(det.sample(80, 5000)).toBeNull(); // spike starts internally, no transition yet
  });

  it('flags a classic stall: 4 spikes ~1800W apart, 5s long, 30s apart, then closes after the retry window', () => {
    const det = new MotorStallDetector();
    expect(det.sample(0, 500)).toBeNull();

    // Spike 1: start=0 is taken by the seed sample above, so start the first
    // spike at ts=1 instead to avoid colliding with the baseline seed.
    expect(det.sample(1, 2300)).toBeNull(); // spike starts (peak 2300, baseline 500)
    expect(det.sample(6, 500)).toBeNull(); // spike 1 ends, duration 5, mag 1800 -> new cluster (count 1)

    expect(det.sample(36, 2300)).toBeNull(); // spike 2 starts (gap since spike1 end = 30)
    expect(det.sample(41, 500)).toBeNull(); // spike 2 ends, duration 5, mag 1800 -> cluster count 2

    expect(det.sample(71, 2300)).toBeNull(); // spike 3 starts
    const detected = det.sample(76, 500); // spike 3 ends, duration 5, mag 1800 -> cluster count 3, flags
    expect(detected).toEqual({
      kind: 'detected',
      active: { startedTs: 1, lastSpikeTs: 76, spikeCount: 3, avgSpikeW: 1800, maxSpikeW: 1800 },
    });
    expect(det.active).toEqual({ startedTs: 1, lastSpikeTs: 76, spikeCount: 3, avgSpikeW: 1800, maxSpikeW: 1800 });

    expect(det.sample(106, 2300)).toBeNull(); // spike 4 starts
    const spike4 = det.sample(111, 500); // spike 4 ends, duration 5, mag 1800 -> cluster count 4
    expect(spike4).toEqual({
      kind: 'spike',
      active: { startedTs: 1, lastSpikeTs: 111, spikeCount: 4, avgSpikeW: 1800, maxSpikeW: 1800 },
    });

    // Advance well past the retry window (300s) with a quiet baseline sample.
    const ended = det.sample(111 + 301, 500);
    expect(ended).toEqual({
      kind: 'ended',
      event: {
        startedTs: 1,
        lastSpikeTs: 111,
        spikeCount: 4,
        avgSpikeW: 1800,
        maxSpikeW: 1800,
        endedTs: 111,
      },
    });
    expect(det.active).toBeNull();
  });

  it('never flags a cluster of only two spikes and closes it silently after the retry window', () => {
    const det = new MotorStallDetector();
    expect(det.sample(0, 500)).toBeNull();

    expect(det.sample(1, 2300)).toBeNull();
    expect(det.sample(6, 500)).toBeNull(); // candidate 1 -> cluster count 1

    expect(det.sample(36, 2300)).toBeNull();
    expect(det.sample(41, 500)).toBeNull(); // candidate 2 -> cluster count 2, still unflagged

    expect(det.active).toBeNull();

    // Advance past the retry window: silent close, null throughout.
    expect(det.sample(41 + 150, 500)).toBeNull();
    expect(det.sample(41 + 301, 500)).toBeNull();
    expect(det.active).toBeNull();
  });

  it('does not cluster a spike whose magnitude falls outside +/-30% of the running average', () => {
    const det = new MotorStallDetector();
    expect(det.sample(0, 500)).toBeNull();

    // +1000W spike
    expect(det.sample(1, 1500)).toBeNull();
    expect(det.sample(6, 500)).toBeNull(); // candidate mag 1000 -> new cluster (count 1, avg 1000)

    // +5000W spike: |5000-1000| = 4000 > 0.3*1000 -> does not join; old (unflagged)
    // cluster closes silently and a fresh cluster of 1 starts internally.
    expect(det.sample(36, 5500)).toBeNull();
    expect(det.sample(41, 500)).toBeNull(); // candidate mag 5000, mismatch vs avg 1000

    // +1000W spike again: |1000-5000| = 4000 > 0.3*5000 -> also does not join.
    expect(det.sample(71, 1500)).toBeNull();
    expect(det.sample(76, 500)).toBeNull();

    // None of the three ever formed a matching trio, so no flag ever fired.
    expect(det.active).toBeNull();
  });

  it('does not flag a single isolated spike', () => {
    const det = new MotorStallDetector();
    expect(det.sample(0, 500)).toBeNull();
    expect(det.sample(1, 2300)).toBeNull();
    expect(det.sample(6, 500)).toBeNull(); // candidate -> cluster count 1
    expect(det.active).toBeNull();

    expect(det.sample(6 + 301, 500)).toBeNull(); // silent close after retry window
    expect(det.active).toBeNull();
  });

  it('skips junk samples (NaN, Infinity, negative wattage) without altering state', () => {
    const det = new MotorStallDetector();
    expect(det.sample(0, 500)).toBeNull();
    expect(det.sample(1, Number.NaN)).toBeNull();
    expect(det.sample(2, -50)).toBeNull();
    expect(det.sample(3, Number.POSITIVE_INFINITY)).toBeNull();
    expect(det.active).toBeNull();

    // Detector still works normally afterward.
    expect(det.sample(4, 500)).toBeNull();
    expect(det.sample(5, 2300)).toBeNull(); // spike starts
    expect(det.sample(10, 500)).toBeNull(); // spike ends -> cluster count 1
    expect(det.active).toBeNull();
  });

  it('discards an in-flight spike across a >60s stream gap, then keeps working', () => {
    const det = new MotorStallDetector();
    expect(det.sample(0, 500)).toBeNull();
    expect(det.sample(10, 2300)).toBeNull(); // spike starts

    // 120s gap while a spike is in flight: discarded, no candidate produced.
    expect(det.sample(130, 500)).toBeNull();
    expect(det.active).toBeNull();

    // Detector still functional: a full matching trio still flags afterward.
    expect(det.sample(200, 2300)).toBeNull();
    expect(det.sample(205, 500)).toBeNull(); // candidate 1

    expect(det.sample(235, 2300)).toBeNull();
    expect(det.sample(240, 500)).toBeNull(); // candidate 2

    expect(det.sample(270, 2300)).toBeNull();
    const detected = det.sample(275, 500); // candidate 3 -> flags
    expect(detected?.kind).toBe('detected');
    expect(det.active).not.toBeNull();
  });

  it('flags exactly at the spikesToFlag boundary (3 matching spikes)', () => {
    const det = new MotorStallDetector();
    expect(det.sample(0, 500)).toBeNull();

    expect(det.sample(1, 2300)).toBeNull();
    expect(det.sample(6, 500)).toBeNull(); // count 1
    expect(det.active).toBeNull();

    expect(det.sample(36, 2300)).toBeNull();
    expect(det.sample(41, 500)).toBeNull(); // count 2
    expect(det.active).toBeNull();

    expect(det.sample(71, 2300)).toBeNull();
    const detected = det.sample(76, 500); // count 3 -> detected
    expect(detected).toEqual({
      kind: 'detected',
      active: { startedTs: 1, lastSpikeTs: 76, spikeCount: 3, avgSpikeW: 1800, maxSpikeW: 1800 },
    });
    expect(det.active).not.toBeNull();
    expect(det.active!.spikeCount).toBe(3);
  });
});
