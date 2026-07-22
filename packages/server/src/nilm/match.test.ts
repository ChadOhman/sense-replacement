import { describe, expect, it } from 'vitest';
import { matchEvent, type MatchProfile } from './match.js';
import { smooth2 } from './kmeans.js';

function stepWaveform(magnitude: number): number[] {
  return Array.from({ length: 20 }, (_, i) => (i === 0 ? magnitude : 0));
}

function profile(
  clusterId: number,
  deviceId: number,
  magnitude: number,
  direction: 'on' | 'off' = 'on',
  radius = 100,
  maxMatchDistance: number | null = null,
): MatchProfile {
  return {
    clusterId,
    deviceId,
    direction,
    profile: smooth2(stepWaveform(magnitude)),
    radius,
    maxMatchDistance,
  };
}

describe('matchEvent', () => {
  it('picks the nearest profile within its radius', () => {
    const profiles = [profile(1, 1, 1000), profile(2, 2, 1100)];
    const match = matchEvent(stepWaveform(1020), 'on', profiles);
    expect(match?.clusterId).toBe(1);
    expect(match?.deviceId).toBe(1);
  });

  it('returns null beyond every radius', () => {
    const profiles = [profile(1, 1, 1000, 'on', 50)];
    expect(matchEvent(stepWaveform(1500), 'on', profiles)).toBeNull();
  });

  it('filters by direction', () => {
    const profiles = [profile(1, 1, 1000, 'off')];
    expect(matchEvent(stepWaveform(1000), 'on', profiles)).toBeNull();
  });

  it('honors the device maxMatchDistance override over the cluster radius', () => {
    // radius alone would match; the tighter device override rejects
    const tight = [profile(1, 1, 1000, 'on', 500, 10)];
    expect(matchEvent(stepWaveform(1100), 'on', tight)).toBeNull();
    // radius alone would reject; the looser device override accepts
    const loose = [profile(1, 1, 1000, 'on', 10, 500)];
    expect(matchEvent(stepWaveform(1100), 'on', loose)).not.toBeNull();
  });
});
