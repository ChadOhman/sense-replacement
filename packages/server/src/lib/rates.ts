import type { RatePlan } from '@sense/shared';

/** Pure billing math. No I/O, no Date.now — callers supply local calendar
 *  fields (month/weekday/hour) and day strings derived elsewhere. */

/** Wraparound half-open window: start<end -> [start,end); start>end ->
 *  [start,24)∪[0,end); start===end -> matches ALL 24 hours (a period
 *  covering the whole day). */
export function hourInWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/** Rate in cents/kWh for a local hour. month 1-12, weekday 0(Sun)-6(Sat),
 *  hour 0-23. TOU: first period matching (months omitted or includes month)
 *  AND (weekdays includes weekday) AND hourInWindow(hour, startHour,
 *  endHour) wins; else defaultCents. Flat: cents. */
export function rateForHour(plan: RatePlan, month: number, weekday: number, hour: number): number {
  if (plan.type === 'flat') return plan.cents;
  for (const period of plan.periods) {
    if (period.months && !period.months.includes(month)) continue;
    if (!period.weekdays.includes(weekday)) continue;
    if (!hourInWindow(hour, period.startHour, period.endHour)) continue;
    return period.cents;
  }
  return plan.defaultCents;
}

/** Cost in CURRENCY UNITS (cents/100) for one local day given per-hour kWh.
 *  hourlyKwh[h] may be null (no data that hour -> contributes 0). month/weekday
 *  are that day's values. */
export function costForDayHourly(plan: RatePlan, month: number, weekday: number, hourlyKwh: (number | null)[]): number {
  let centsSum = 0;
  for (let hour = 0; hour < hourlyKwh.length; hour++) {
    const kwh = hourlyKwh[hour];
    if (kwh === null || kwh === undefined) continue;
    centsSum += kwh * rateForHour(plan, month, weekday, hour);
  }
  return centsSum / 100;
}

/** Volume-weighted "typical" rate in cents/kWh: average of rateForHour across
 *  all 24h × 7 weekdays of a given month, equal weights. Used to cost days
 *  that predate hourly data. */
export function blendedRateCents(plan: RatePlan, month: number): number {
  let sum = 0;
  let n = 0;
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      sum += rateForHour(plan, month, weekday, hour);
      n++;
    }
  }
  return sum / n;
}

/** Billing-cycle window containing `day` (YYYY-MM-DD local). Cycle starts on
 *  billingCycleDay (1-28) of each month. If day-of-month >= billingCycleDay the
 *  cycle started this month, else the previous month. Returns start (inclusive),
 *  end (exclusive = same day next month), dayOfCycle (1-based position of `day`),
 *  daysInCycle. */
export function cycleWindow(
  day: string,
  billingCycleDay: number,
): { startDay: string; endDay: string; dayOfCycle: number; daysInCycle: number } {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const cycleDayStr = String(billingCycleDay).padStart(2, '0');
  const candidateStart = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${cycleDayStr}`;

  let startDay: string;
  if (day >= candidateStart) {
    startDay = candidateStart;
  } else {
    // Previous month, handling January -> previous December.
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    startDay = `${String(prevYear).padStart(4, '0')}-${String(prevMonth).padStart(2, '0')}-${cycleDayStr}`;
  }

  // End = same cycle day, one month after startDay.
  const startYear = Number(startDay.slice(0, 4));
  const startMonth = Number(startDay.slice(5, 7));
  const nextMonth = startMonth === 12 ? 1 : startMonth + 1;
  const nextYear = startMonth === 12 ? startYear + 1 : startYear;
  const endDay = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${cycleDayStr}`;

  // Count days via addDays' noon-anchor UTC math for DST/calendar safety.
  const msPerDay = 24 * 60 * 60 * 1000;
  const noonOf = (d: string): number => new Date(`${d}T12:00:00Z`).getTime();
  const dayOfCycle = Math.round((noonOf(day) - noonOf(startDay)) / msPerDay) + 1;
  const daysInCycle = Math.round((noonOf(endDay) - noonOf(startDay)) / msPerDay);

  return { startDay, endDay, dayOfCycle, daysInCycle };
}

/** Forecast total cycle cost: toDateCost + avg(dailyCosts of up to last 14
 *  complete days) × daysRemaining. Returns null if dailyCosts is empty. */
export function forecastCycleCost(toDateCost: number, recentDailyCosts: number[], daysRemaining: number): number | null {
  if (recentDailyCosts.length === 0) return null;
  const recent = recentDailyCosts.slice(-14);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  return toDateCost + avg * daysRemaining;
}
