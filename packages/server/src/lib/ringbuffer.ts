import type { LiveFrame } from '@sense/shared';

/** In-memory buffer of the last `capacitySeconds` of ~1 Hz live frames.
 *  Powers instant chart fill on page load and the 30s rollup flush. */
export class LiveRingBuffer {
  private frames: LiveFrame[] = [];

  constructor(private readonly capacitySeconds = 3600) {}

  push(frame: LiveFrame): void {
    this.frames.push(frame);
    const cutoff = frame.ts - this.capacitySeconds;
    // Frames arrive in order; trim from the front.
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop]!.ts < cutoff) drop++;
    if (drop > 0) this.frames.splice(0, drop);
  }

  latest(): LiveFrame | null {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1]! : null;
  }

  /** Frames with ts in [from, to). */
  range(from: number, to: number): LiveFrame[] {
    return this.frames.filter((f) => f.ts >= from && f.ts < to);
  }

  all(): readonly LiveFrame[] {
    return this.frames;
  }
}
