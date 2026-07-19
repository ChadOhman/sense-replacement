import { describe, expect, it } from 'vitest';
import { BrownoutDetector } from './brownout.js';

describe('BrownoutDetector', () => {
  it('reports no transition for healthy readings', () => {
    const det = new BrownoutDetector();
    expect(det.sample(0, [120, 121])).toBeNull();
    expect(det.sample(1, [119, 122])).toBeNull();
    expect(det.active).toBeNull();
  });

  it('starts and ends a sag lasting >= minDurationS, tracking the worst leg', () => {
    const det = new BrownoutDetector();
    expect(det.sample(0, [120, 120])).toBeNull();

    const started = det.sample(1, [105, 120]); // leg 0 sags below 108 (0.90 * 120)
    expect(started).toEqual({
      kind: 'started',
      active: { startedTs: 1, leg: 0, minVolts: 105, nominalVolts: 120 },
    });
    expect(det.active).not.toBeNull();

    expect(det.sample(2, [102, 120])).toBeNull(); // deeper dip, still active
    expect(det.active!.minVolts).toBe(102);
    expect(det.active!.leg).toBe(0);

    expect(det.sample(3, [107, 120])).toBeNull(); // recovering but below end threshold (110.4)

    const ended = det.sample(6, [120, 120]); // full recovery, duration = 6 - 1 = 5
    expect(ended).toEqual({
      kind: 'ended',
      event: { startedTs: 1, endedTs: 6, leg: 0, minVolts: 102, nominalVolts: 120 },
    });
    expect(det.active).toBeNull();
  });

  it('discards a transient that recovers before minDurationS', () => {
    const det = new BrownoutDetector();
    det.sample(0, [120, 120]);
    const started = det.sample(10, [100, 120]);
    expect(started?.kind).toBe('started');

    const result = det.sample(13, [120, 120]); // duration = 3s < 5s
    expect(result).toEqual({ kind: 'discarded' });
    expect(det.active).toBeNull();
  });

  it('honors hysteresis: recovery inside the start/end band does not end the event', () => {
    const det = new BrownoutDetector();
    det.sample(0, [120, 120]);
    det.sample(1, [100, 120]); // started, minVolts=100 leg=0

    // 108.5 is between startRatio*120 (108) and endRatio*120 (110.4): stays active.
    expect(det.sample(2, [108.5, 120])).toBeNull();
    expect(det.active).not.toBeNull();
    expect(det.active!.minVolts).toBe(100);

    // 110.4 meets the end threshold exactly: ends (duration = 7 - 1 = 6 >= 5).
    const ended = det.sample(7, [110.4, 120]);
    expect(ended).toEqual({
      kind: 'ended',
      event: { startedTs: 1, endedTs: 7, leg: 0, minVolts: 100, nominalVolts: 120 },
    });
  });

  it('ignores glitch samples (leg <= 20V) and empty frames entirely', () => {
    const det = new BrownoutDetector();
    expect(det.sample(0, [120, 120])).toBeNull();
    expect(det.sample(1, [0, 120])).toBeNull();
    expect(det.active).toBeNull();
    expect(det.sample(2, [5, 120])).toBeNull();
    expect(det.active).toBeNull();
    expect(det.sample(3, [])).toBeNull();
    expect(det.active).toBeNull();
    // Sanity: a genuine severe sag (>20V, <100V) still starts an event.
    const started = det.sample(4, [50, 120]);
    expect(started?.kind).toBe('started');
  });

  it('learns nominal upward toward a steady observed voltage, scaling thresholds', () => {
    const det = new BrownoutDetector();
    for (let i = 0; i < 2000; i++) {
      det.sample(i, [124, 124]);
    }
    expect(det.nominal).toBeGreaterThan(121);
    expect(det.nominal).toBeLessThanOrEqual(124);

    const nominal = det.nominal;
    const sagLeg = nominal * 0.85; // clearly below startRatio * learned nominal
    const transition = det.sample(2001, [sagLeg, 124]);
    expect(transition?.kind).toBe('started');
    expect(transition && transition.kind === 'started' ? transition.active.nominalVolts : null).toBeCloseTo(nominal, 5);
  });

  it('ends an active event at the last-seen ts when the stream gaps beyond tolerance', () => {
    const det = new BrownoutDetector();
    det.sample(0, [120, 120]);
    const started = det.sample(1, [100, 120]);
    expect(started?.kind).toBe('started');
    det.sample(2, [95, 120]); // min so far
    det.sample(6, [97, 120]); // still active, min stays 95

    const afterGap = det.sample(6 + 120, [120, 120]); // 120s gap > 60s tolerance
    expect(afterGap).toEqual({
      kind: 'ended',
      event: { startedTs: 1, endedTs: 6, leg: 0, minVolts: 95, nominalVolts: 120 },
    });
    expect(det.active).toBeNull(); // fresh sample was healthy, no new event started
  });
});
