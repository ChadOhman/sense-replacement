/**
 * Rolling always-on floor for live unknown-power accounting: the minimum
 * whole-home draw over the trailing hour, bucketed per minute so each
 * sample is O(1) and a read scans at most 60 buckets. (The rigorous daily
 * always-on figure lives in collector/analytics.ts; this is just an
 * adaptive live floor.)
 */

const WINDOW_MINUTES = 60;

export class RollingMinBaseline {
  /** minute index -> min watts seen that minute. */
  private readonly buckets = new Map<number, number>();

  sample(ts: number, w: number): void {
    if (w < 0 || !Number.isFinite(w)) return;
    const minute = Math.floor(ts / 60);
    const current = this.buckets.get(minute);
    if (current === undefined || w < current) this.buckets.set(minute, w);
    for (const key of this.buckets.keys()) {
      if (key <= minute - WINDOW_MINUTES) this.buckets.delete(key);
    }
  }

  /** Trailing-window minimum; null before any sample. */
  value(): number | null {
    if (this.buckets.size === 0) return null;
    let min = Infinity;
    for (const v of this.buckets.values()) min = Math.min(min, v);
    return min;
  }
}
