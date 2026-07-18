/** Timezone-aware day bucketing. Storage is epoch-seconds UTC; these helpers
 *  convert to local-day strings only at bucket boundaries. */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Epoch seconds -> 'YYYY-MM-DD' in the given IANA timezone. */
export function tsToLocalDay(ts: number, tz: string): string {
  return dtf(tz).format(new Date(ts * 1000)); // en-CA gives YYYY-MM-DD
}

export function todayLocal(tz: string, now = Date.now()): string {
  return tsToLocalDay(Math.floor(now / 1000), tz);
}

/** 'YYYY-MM-DD' plus/minus n days (pure calendar arithmetic, UTC-safe). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM' of a day string. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** Epoch seconds of local midnight starting the given local day.
 *  Found by scanning: correct across DST transitions without a TZ library. */
export function localDayStartTs(day: string, tz: string): number {
  // Start from UTC midnight and search +-26h in 15-min steps for the boundary.
  const base = Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000);
  let lo = base - 26 * 3600;
  let hi = base + 26 * 3600;
  // Binary search the first ts whose local day >= day.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (tsToLocalDay(mid, tz) >= day) hi = mid;
    else lo = mid;
  }
  return hi;
}
