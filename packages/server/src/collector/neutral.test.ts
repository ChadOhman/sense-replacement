import { describe, expect, it } from 'vitest';
import { FloatingNeutralDetector } from './neutral.js';

describe('FloatingNeutralDetector', () => {
  it('reports no transition for healthy balanced legs', () => {
    const det = new FloatingNeutralDetector();
    expect(det.sample(0, [121, 122])).toBeNull();
    expect(det.sample(1, [122, 121])).toBeNull();
    expect(det.active).toBeNull();
  });

  it('starts and ends a classic divergence episode lasting >= minDurationS', () => {
    const det = new FloatingNeutralDetector();
    expect(det.sample(0, [120, 120])).toBeNull();

    // Leg 0 rises above nominal+3, leg 1 falls below nominal-3: anti-correlated.
    const started = det.sample(1, [128, 112]);
    expect(started).toEqual({
      kind: 'started',
      active: {
        startedTs: 1,
        maxSpreadVolts: 16,
        highLeg: 0,
        peakHighVolts: 128,
        peakLowVolts: 112,
        nominalVolts: 120,
      },
    });
    expect(det.active).not.toBeNull();

    // Recovery beyond endVolts hysteresis, duration = 4 - 1 = 3 >= 3.
    const ended = det.sample(4, [121, 119]);
    expect(ended).toEqual({
      kind: 'ended',
      episode: {
        startedTs: 1,
        endedTs: 4,
        maxSpreadVolts: 16,
        highLeg: 0,
        peakHighVolts: 128,
        peakLowVolts: 112,
        nominalVolts: 120,
      },
    });
    expect(det.active).toBeNull();
  });

  it('does not trigger when both legs sag together (that is a brownout, not floating neutral)', () => {
    const det = new FloatingNeutralDetector();
    expect(det.sample(0, [120, 120])).toBeNull();
    expect(det.sample(1, [112, 113])).toBeNull();
    expect(det.active).toBeNull();
  });

  it('does not trigger when both legs rise together', () => {
    const det = new FloatingNeutralDetector();
    expect(det.sample(0, [120, 120])).toBeNull();
    expect(det.sample(1, [128, 127])).toBeNull();
    expect(det.active).toBeNull();
  });

  it('discards a transient that recovers before minDurationS', () => {
    const det = new FloatingNeutralDetector();
    det.sample(0, [120, 120]);
    const started = det.sample(10, [128, 112]);
    expect(started?.kind).toBe('started');

    const result = det.sample(12, [121, 119]); // duration = 2s < 3s
    expect(result).toEqual({ kind: 'discarded' });
    expect(det.active).toBeNull();
  });

  it('honors hysteresis: partial recovery within the diverge/end band keeps the episode active', () => {
    const det = new FloatingNeutralDetector();
    det.sample(0, [120, 120]);
    det.sample(1, [128, 112]); // started, maxSpread=16

    // 122.5/117.5 still satisfies divergence at endVolts=2 (122/118): stays active.
    expect(det.sample(2, [122.5, 117.5])).toBeNull();
    expect(det.active).not.toBeNull();
    expect(det.active!.maxSpreadVolts).toBe(16);

    // 121.5/119 no longer satisfies endVolts divergence: ends (duration = 4 - 1 = 3 >= 3).
    const ended = det.sample(4, [121.5, 119]);
    expect(ended).toEqual({
      kind: 'ended',
      episode: {
        startedTs: 1,
        endedTs: 4,
        maxSpreadVolts: 16,
        highLeg: 0,
        peakHighVolts: 128,
        peakLowVolts: 112,
        nominalVolts: 120,
      },
    });
  });

  it('tracks peak spread through growth and shrinkage during an episode', () => {
    const det = new FloatingNeutralDetector();

    const started = det.sample(0, [124, 116]); // spread 8
    expect(started?.kind).toBe('started');
    expect(det.active!.maxSpreadVolts).toBe(8);

    det.sample(1, [128, 112]); // spread grows to 16
    expect(det.active!.maxSpreadVolts).toBe(16);
    expect(det.active!.highLeg).toBe(0);
    expect(det.active!.peakHighVolts).toBe(128);
    expect(det.active!.peakLowVolts).toBe(112);

    det.sample(2, [126, 114]); // spread shrinks to 12, peak must not regress
    expect(det.active!.maxSpreadVolts).toBe(16);
    expect(det.active!.peakHighVolts).toBe(128);
    expect(det.active!.peakLowVolts).toBe(112);

    const ended = det.sample(4, [121, 119]); // duration = 4 - 0 = 4 >= 3
    expect(ended).toEqual({
      kind: 'ended',
      episode: {
        startedTs: 0,
        endedTs: 4,
        maxSpreadVolts: 16,
        highLeg: 0,
        peakHighVolts: 128,
        peakLowVolts: 112,
        nominalVolts: 120,
      },
    });
  });

  it('ignores glitch samples (leg <= 20V) and malformed frames entirely', () => {
    const det = new FloatingNeutralDetector();
    expect(det.sample(0, [120, 120])).toBeNull();
    expect(det.sample(1, [0, 120])).toBeNull();
    expect(det.active).toBeNull();
    expect(det.sample(2, [5, 120])).toBeNull();
    expect(det.active).toBeNull();
    expect(det.sample(3, [120])).toBeNull(); // wrong leg count
    expect(det.active).toBeNull();
    expect(det.sample(4, [120, 120, 120])).toBeNull(); // wrong leg count
    expect(det.active).toBeNull();
    // Sanity: a genuine divergence still starts an episode afterward.
    const started = det.sample(5, [128, 112]);
    expect(started?.kind).toBe('started');
  });

  it('ends an active episode at the last-seen ts when the stream gaps beyond tolerance', () => {
    const det = new FloatingNeutralDetector();
    det.sample(0, [120, 120]);
    const started = det.sample(1, [128, 112]);
    expect(started?.kind).toBe('started');
    det.sample(2, [126, 114]); // still active, spread shrinks but stays divergent
    det.sample(6, [128, 112]); // still active, back to max spread

    const afterGap = det.sample(6 + 120, [120, 120]); // 120s gap > 60s tolerance
    expect(afterGap).toEqual({
      kind: 'ended',
      episode: {
        startedTs: 1,
        endedTs: 6,
        maxSpreadVolts: 16,
        highLeg: 0,
        peakHighVolts: 128,
        peakLowVolts: 112,
        nominalVolts: 120,
      },
    });
    expect(det.active).toBeNull(); // fresh sample was healthy, no new episode started
  });

  it('learns nominal upward toward a steady observed voltage, scaling thresholds', () => {
    const det = new FloatingNeutralDetector();
    for (let i = 0; i < 2000; i++) {
      det.sample(i, [124, 124]);
    }
    expect(det.nominal).toBeGreaterThan(121);
    expect(det.nominal).toBeLessThanOrEqual(124);

    const nominal = det.nominal;
    const highLeg = nominal + 4; // clearly beyond divergeVolts (3) above learned nominal
    const lowLeg = nominal - 4; // clearly beyond divergeVolts (3) below learned nominal
    const transition = det.sample(2001, [highLeg, lowLeg]);
    expect(transition?.kind).toBe('started');
    expect(
      transition && transition.kind === 'started' ? transition.active.nominalVolts : null,
    ).toBeCloseTo(nominal, 5);
  });
});
