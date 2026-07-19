import { describe, expect, it } from 'vitest';
import type { RatePlan } from '@sense/shared';
import { blendedRateCents, costForDayHourly, cycleWindow, forecastCycleCost, hourInWindow, rateForHour } from './rates.js';

const FLAT: RatePlan = { type: 'flat', cents: 15 };

describe('flat plan', () => {
  it('rateForHour is constant regardless of month/weekday/hour', () => {
    expect(rateForHour(FLAT, 1, 0, 0)).toBe(15);
    expect(rateForHour(FLAT, 7, 3, 16)).toBe(15);
    expect(rateForHour(FLAT, 12, 6, 23)).toBe(15);
  });

  it('costForDayHourly sums correctly with nulls contributing 0', () => {
    const hourlyKwh: (number | null)[] = new Array(24).fill(null);
    hourlyKwh[0] = 1;
    hourlyKwh[1] = 2;
    hourlyKwh[10] = null;
    hourlyKwh[23] = 3;
    // (1 + 2 + 3) kWh * 15 cents / 100 = 0.90
    expect(costForDayHourly(FLAT, 1, 3, hourlyKwh)).toBeCloseTo(0.9, 10);
  });

  it('blendedRateCents equals the flat cents', () => {
    expect(blendedRateCents(FLAT, 7)).toBe(15);
  });
});

describe('hourInWindow', () => {
  it('handles a simple non-wrapping range', () => {
    expect(hourInWindow(16, 16, 21)).toBe(true);
    expect(hourInWindow(20, 16, 21)).toBe(true);
    expect(hourInWindow(21, 16, 21)).toBe(false);
    expect(hourInWindow(15, 16, 21)).toBe(false);
  });

  it('handles wraparound: 21->7 matches 23 and 3, not 12', () => {
    expect(hourInWindow(23, 21, 7)).toBe(true);
    expect(hourInWindow(3, 21, 7)).toBe(true);
    expect(hourInWindow(12, 21, 7)).toBe(false);
    expect(hourInWindow(21, 21, 7)).toBe(true);
    expect(hourInWindow(6, 21, 7)).toBe(true);
    expect(hourInWindow(7, 21, 7)).toBe(false);
  });

  it('start === end matches everything', () => {
    for (let h = 0; h < 24; h++) expect(hourInWindow(h, 5, 5)).toBe(true);
  });
});

describe('TOU plan', () => {
  it('first-match-wins with overlapping periods', () => {
    const plan: RatePlan = {
      type: 'tou',
      periods: [
        { name: 'first', weekdays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24, cents: 10 },
        { name: 'second', weekdays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24, cents: 20 },
      ],
      defaultCents: 5,
    };
    expect(rateForHour(plan, 3, 2, 10)).toBe(10);
  });

  it('weekday filtering: a weekend-only period does not match Wednesday', () => {
    const plan: RatePlan = {
      type: 'tou',
      periods: [{ name: 'weekend', weekdays: [0, 6], startHour: 0, endHour: 24, cents: 9 }],
      defaultCents: 4,
    };
    // Wednesday = weekday 3
    expect(rateForHour(plan, 5, 3, 12)).toBe(4);
    expect(rateForHour(plan, 5, 6, 12)).toBe(9);
  });

  it('months filtering: a summer-only period does not match January', () => {
    const plan: RatePlan = {
      type: 'tou',
      periods: [{ name: 'summer', months: [6, 7, 8], weekdays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24, cents: 18 }],
      defaultCents: 6,
    };
    expect(rateForHour(plan, 1, 3, 12)).toBe(6);
    expect(rateForHour(plan, 7, 3, 12)).toBe(18);
  });

  it('unmatched hours fall back to defaultCents', () => {
    const plan: RatePlan = {
      type: 'tou',
      periods: [{ name: 'narrow', weekdays: [1], startHour: 10, endHour: 11, cents: 99 }],
      defaultCents: 11,
    };
    expect(rateForHour(plan, 1, 2, 10)).toBe(11); // wrong weekday
    expect(rateForHour(plan, 1, 1, 12)).toBe(11); // wrong hour
  });
});

describe('realistic TOU plan (on-peak 13c 4-9pm weekdays, off-peak 7c else)', () => {
  const plan: RatePlan = {
    type: 'tou',
    periods: [{ name: 'on-peak', weekdays: [1, 2, 3, 4, 5], startHour: 16, endHour: 21, cents: 13 }],
    defaultCents: 7,
  };

  it('costForDayHourly for a synthetic weekday with known kWh distribution', () => {
    const weekday = 3; // Wednesday
    const hourlyKwh: (number | null)[] = new Array(24).fill(null);
    hourlyKwh[15] = 2; // off-peak (7c): 2 * 7 = 14
    hourlyKwh[16] = 3; // on-peak (13c): 3 * 13 = 39
    hourlyKwh[20] = 1; // on-peak (13c), endHour exclusive still inside: 1 * 13 = 13
    hourlyKwh[21] = 4; // off-peak (13c window ended at 21, exclusive): 4 * 7 = 28
    // total cents = 14 + 39 + 13 + 28 = 94 -> 0.94 currency units
    expect(costForDayHourly(plan, 7, weekday, hourlyKwh)).toBeCloseTo(0.94, 10);
  });

  it('blendedRateCents falls strictly between the min and max period rates', () => {
    const blended = blendedRateCents(plan, 7);
    expect(blended).toBeGreaterThan(7);
    expect(blended).toBeLessThan(13);
  });
});

describe('cycleWindow', () => {
  it('mid-cycle', () => {
    expect(cycleWindow('2026-07-19', 15)).toEqual({
      startDay: '2026-07-15',
      endDay: '2026-08-15',
      dayOfCycle: 5,
      daysInCycle: 31,
    });
  });

  it('before the cycle day falls into the previous month', () => {
    expect(cycleWindow('2026-07-10', 15)).toEqual({
      startDay: '2026-06-15',
      endDay: '2026-07-15',
      dayOfCycle: 26,
      daysInCycle: 30,
    });
  });

  it('handles December -> January year rollover', () => {
    const result = cycleWindow('2025-12-20', 15);
    expect(result.startDay).toBe('2025-12-15');
    expect(result.endDay).toBe('2026-01-15');
    expect(result.dayOfCycle).toBe(6);
    expect(result.daysInCycle).toBe(31);
  });

  it('cycleDay 1 gives plain calendar months', () => {
    expect(cycleWindow('2026-07-19', 1)).toEqual({
      startDay: '2026-07-01',
      endDay: '2026-08-01',
      dayOfCycle: 19,
      daysInCycle: 31,
    });
  });

  it('February in a non-leap year has 28 days', () => {
    expect(cycleWindow('2026-02-10', 1)).toEqual({
      startDay: '2026-02-01',
      endDay: '2026-03-01',
      dayOfCycle: 10,
      daysInCycle: 28,
    });
  });
});

describe('forecastCycleCost', () => {
  it('normal case: toDateCost + avg(recent daily costs) * daysRemaining', () => {
    expect(forecastCycleCost(100, [10, 20, 30], 5)).toBeCloseTo(100 + 20 * 5, 10);
  });

  it('empty history returns null', () => {
    expect(forecastCycleCost(100, [], 5)).toBeNull();
  });

  it('zero daysRemaining returns toDateCost', () => {
    expect(forecastCycleCost(50, [10, 20], 0)).toBe(50);
  });

  it('uses only the last 14 complete days of history', () => {
    const many = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    const last14 = many.slice(-14); // 7..20
    const avg = last14.reduce((a, b) => a + b, 0) / last14.length;
    expect(forecastCycleCost(0, many, 1)).toBeCloseTo(avg, 10);
  });
});
