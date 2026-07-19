/** Pairing device on/off events into completed runs. Pure. */

export interface RunEvent {
  ts: number;
  type: 'on' | 'off';
}

export interface CompletedRun {
  onTs: number;
  offTs: number;
  durationS: number;
}

/** Pair on→off events into completed runs. Events may arrive in any order and
 *  may contain unmatched edges (missed transitions, restarts): an 'off' with
 *  no preceding 'on' is dropped, consecutive 'on's keep the latest. Runs
 *  shorter than minDurationS are dropped (detection blips). */
export function pairRuns(events: RunEvent[], minDurationS = 60): CompletedRun[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const runs: CompletedRun[] = [];
  let onTs: number | null = null;
  for (const e of sorted) {
    if (e.type === 'on') {
      onTs = e.ts;
    } else if (onTs !== null) {
      const durationS = e.ts - onTs;
      if (durationS >= minDurationS) runs.push({ onTs, offTs: e.ts, durationS });
      onTs = null;
    }
  }
  return runs;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
