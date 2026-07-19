import { DEFAULT_ALERT_SETTINGS } from '@sense/shared';
import type { AlertSettings } from '@sense/shared';
import { describe, expect, it } from 'vitest';
import type { AppEvent } from './events.js';
import { DeviceRuntimeTracker, formatEvent, kindOf, shouldSend } from './rules.js';

function settings(overrides: Partial<AlertSettings> = {}): AlertSettings {
  return {
    ...DEFAULT_ALERT_SETTINGS,
    ...overrides,
    enabled: { ...DEFAULT_ALERT_SETTINGS.enabled, ...overrides.enabled },
  };
}

describe('kindOf', () => {
  it('maps every event variant to its toggle category', () => {
    const cases: [AppEvent, ReturnType<typeof kindOf>][] = [
      [{ type: 'brownout.started', ts: 0, leg: 0, minVolts: 100, nominalVolts: 120 }, 'brownout'],
      [{ type: 'brownout.ended', ts: 0, leg: 0, minVolts: 100, durationS: 10 }, 'brownout'],
      [{ type: 'neutral.started', ts: 0, maxSpreadVolts: 10 }, 'neutral'],
      [{ type: 'neutral.ended', ts: 0, maxSpreadVolts: 10, durationS: 10 }, 'neutral'],
      [{ type: 'stall.detected', ts: 0, spikeCount: 3, avgSpikeW: 500 }, 'stall'],
      [{ type: 'stall.ended', ts: 0, spikeCount: 3, avgSpikeW: 500, maxSpikeW: 700 }, 'stall'],
      [{ type: 'device.on', ts: 0, deviceId: 'd1', name: 'Fridge', w: 150 }, null],
      [{ type: 'device.off', ts: 0, deviceId: 'd1', name: 'Fridge', runtimeS: 300 }, 'device_finished'],
      [{ type: 'alwayson.creep', ts: 0, currentW: 200, baselineW: 100 }, 'alwayson_creep'],
      [
        { type: 'anomaly.device', ts: 0, deviceId: 'd1', name: 'Fridge', pct: 50, direction: 'up' },
        'device_anomaly',
      ],
    ];

    for (const [event, expected] of cases) {
      expect(kindOf(event)).toBe(expected);
    }
  });
});

describe('formatEvent', () => {
  it('formats brownout.started as a high-priority alert with leg/voltage specifics', () => {
    const result = formatEvent({
      type: 'brownout.started',
      ts: 0,
      leg: 0,
      minVolts: 103.0,
      nominalVolts: 121,
    });
    expect(result.title).toMatch(/brownout/i);
    expect(result.title).toMatch(/start/i);
    expect(result.body).toContain('Leg 1');
    expect(result.body).toContain('103.0 V');
    expect(result.body).toContain('121 V');
    expect(result.priority).toBe('high');
    expect(result.tags.length).toBeGreaterThan(0);
  });

  it('formats stall.detected as a high-priority alert with spike specifics', () => {
    const result = formatEvent({
      type: 'stall.detected',
      ts: 0,
      spikeCount: 4,
      avgSpikeW: 812,
    });
    expect(result.title).toMatch(/stall/i);
    expect(result.body).toContain('4');
    expect(result.body).toContain('812');
    expect(result.priority).toBe('high');
    expect(result.tags.length).toBeGreaterThan(0);
  });

  it('formats device.off with name/runtime specifics', () => {
    const result = formatEvent({
      type: 'device.off',
      ts: 0,
      deviceId: 'd1',
      name: 'Dryer',
      runtimeS: 42 * 60,
    });
    expect(result.title).toBe('Dryer finished');
    expect(result.body).toBe('Ran for 42 min');
    expect(result.priority).toBe('default');
    expect(result.tags.length).toBeGreaterThan(0);
  });

  it('formats device.off with null runtime without throwing', () => {
    const result = formatEvent({
      type: 'device.off',
      ts: 0,
      deviceId: 'd1',
      name: 'Dryer',
      runtimeS: null,
    });
    expect(result.title).toBe('Dryer finished');
    expect(result.body.length).toBeGreaterThan(0);
  });
});

describe('shouldSend', () => {
  const brownoutStarted: AppEvent = {
    type: 'brownout.started',
    ts: 1000,
    leg: 0,
    minVolts: 100,
    nominalVolts: 120,
  };

  it('blocks when the kind is disabled', () => {
    const s = settings({ enabled: { ...DEFAULT_ALERT_SETTINGS.enabled, brownout: false } });
    expect(shouldSend(brownoutStarted, s, 12, null, 1000)).toBe(false);
  });

  it('allows when never sent before (lastSentTs null)', () => {
    const s = settings();
    expect(shouldSend(brownoutStarted, s, 12, null, 1000)).toBe(true);
  });

  it('debounce: blocks at 299s, allows at 300s', () => {
    const s = settings();
    expect(shouldSend(brownoutStarted, s, 12, 1000, 1000 + 299)).toBe(false);
    expect(shouldSend(brownoutStarted, s, 12, 1000, 1000 + 300)).toBe(true);
  });

  it('quiet hours suppress default-priority alerts but not high-priority', () => {
    const s = settings({ quietHours: { startHour: 22, endHour: 7 } });
    // stall.detected is high priority -> not suppressed
    const stall: AppEvent = { type: 'stall.detected', ts: 0, spikeCount: 2, avgSpikeW: 400 };
    expect(shouldSend(stall, s, 23, null, 1000)).toBe(true);

    // device.off (device_finished) is default priority -> suppressed during quiet hours
    const s2 = settings({
      quietHours: { startHour: 22, endHour: 7 },
      enabled: { ...DEFAULT_ALERT_SETTINGS.enabled, device_finished: true },
      finishedDeviceIds: ['d1'],
      finishedMinRuntimeS: 60,
    });
    const off: AppEvent = { type: 'device.off', ts: 0, deviceId: 'd1', name: 'Dryer', runtimeS: 120 };
    expect(shouldSend(off, s2, 23, null, 1000)).toBe(false);
  });

  it('quiet hours wraparound (22-7) covers hour 23 and hour 3 but not hour 12', () => {
    const s = settings({ quietHours: { startHour: 22, endHour: 7 } });
    // Use a default-priority event (brownout.ended) so quiet hours actually matter.
    const ended: AppEvent = { type: 'brownout.ended', ts: 0, leg: 0, minVolts: 118, durationS: 30 };
    expect(shouldSend(ended, s, 23, null, 1000)).toBe(false);
    expect(shouldSend(ended, s, 3, null, 1000)).toBe(false);
    expect(shouldSend(ended, s, 12, null, 1000)).toBe(true);
  });

  it('startHour === endHour means never quiet', () => {
    const s = settings({ quietHours: { startHour: 5, endHour: 5 } });
    const ended: AppEvent = { type: 'brownout.ended', ts: 0, leg: 0, minVolts: 118, durationS: 30 };
    expect(shouldSend(ended, s, 5, null, 1000)).toBe(true);
    expect(shouldSend(ended, s, 0, null, 1000)).toBe(true);
  });

  describe('device_finished gating', () => {
    const base = settings({
      enabled: { ...DEFAULT_ALERT_SETTINGS.enabled, device_finished: true },
      finishedDeviceIds: ['d1'],
      finishedMinRuntimeS: 300,
    });

    it('blocks when device is not in finishedDeviceIds', () => {
      const off: AppEvent = { type: 'device.off', ts: 0, deviceId: 'other', name: 'X', runtimeS: 600 };
      expect(shouldSend(off, base, 12, null, 1000)).toBe(false);
    });

    it('blocks when runtime is too short', () => {
      const off: AppEvent = { type: 'device.off', ts: 0, deviceId: 'd1', name: 'X', runtimeS: 100 };
      expect(shouldSend(off, base, 12, null, 1000)).toBe(false);
    });

    it('blocks when runtime is null', () => {
      const off: AppEvent = { type: 'device.off', ts: 0, deviceId: 'd1', name: 'X', runtimeS: null };
      expect(shouldSend(off, base, 12, null, 1000)).toBe(false);
    });

    it('allows when device is listed, runtime meets threshold, kind enabled, not debounced/quiet', () => {
      const off: AppEvent = { type: 'device.off', ts: 0, deviceId: 'd1', name: 'X', runtimeS: 300 };
      expect(shouldSend(off, base, 12, null, 1000)).toBe(true);
    });
  });
});

describe('DeviceRuntimeTracker', () => {
  it('returns elapsed seconds between markOn and markOff', () => {
    const tracker = new DeviceRuntimeTracker();
    tracker.markOn('d1', 1000);
    expect(tracker.markOff('d1', 1300)).toBe(300);
  });

  it('returns null for markOff without a prior markOn', () => {
    const tracker = new DeviceRuntimeTracker();
    expect(tracker.markOff('unknown', 1000)).toBeNull();
  });

  it('clears state after markOff so a subsequent markOff returns null', () => {
    const tracker = new DeviceRuntimeTracker();
    tracker.markOn('d1', 1000);
    expect(tracker.markOff('d1', 1300)).toBe(300);
    expect(tracker.markOff('d1', 1400)).toBeNull();
  });
});
