/**
 * Pure transient-event capture on the 1 Hz whole-home wattage stream. No
 * I/O, no wall-clock reads — time comes in via the `ts` argument, so this is
 * fully deterministic and unit-testable, matching the detector convention in
 * collector/stall.ts.
 *
 * When the per-second power delta exceeds the trigger threshold, a
 * fixed-length window of deltas is recorded as the event's waveform — the
 * "signature" of whatever appliance just switched. Further triggers inside
 * the window are absorbed into the same event (two appliances switching
 * within the window merge; an accepted limitation of the fixed-window
 * design). The waveform is what downstream clustering and matching operate
 * on; the raw 1 Hz stream itself is never persisted.
 */

export interface CaptureOptions {
  /** Per-second delta (watts) that starts a capture. Default 20. */
  triggerW?: number;
  /** Samples per event waveform. Default 20. */
  windowSize?: number;
}

export interface CapturedEvent {
  /** ts of the triggering sample (waveform[0] is that sample's delta). */
  startTs: number;
  /** Per-second watt deltas, windowSize long. */
  waveform: number[];
  /** Net power change over the window (sum of deltas, signed). */
  deltaW: number;
  direction: 'on' | 'off';
}

const DEFAULT_TRIGGER_W = 20;
const DEFAULT_WINDOW_SIZE = 20;

/** ts jump larger than this aborts an in-flight capture and reseeds. */
const GAP_TOLERANCE_S = 5;

export class EventCaptureDetector {
  private triggerW: number;
  private readonly windowSize: number;

  private prevW: number | null = null;
  private lastTs: number | null = null;
  private capture: { startTs: number; samples: number[] } | null = null;

  constructor(opts: CaptureOptions = {}) {
    this.triggerW = opts.triggerW ?? DEFAULT_TRIGGER_W;
    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE;
  }

  /** Runtime tuning: applies to captures started after this call. */
  setTriggerW(value: number): void {
    this.triggerW = value;
  }

  /**
   * Feed one whole-home power sample. Junk samples (negative or non-finite
   * wattage) are skipped entirely. Returns a completed event or null.
   */
  sample(ts: number, w: number): CapturedEvent | null {
    if (w < 0 || !Number.isFinite(w)) return null;

    if (this.prevW === null || (this.lastTs !== null && ts - this.lastTs > GAP_TOLERANCE_S)) {
      // First sample, or a stream gap: an in-flight capture would span the
      // dropout, so drop it and reseed rather than fabricate deltas.
      this.capture = null;
      this.prevW = w;
      this.lastTs = ts;
      return null;
    }

    const delta = w - this.prevW;
    this.prevW = w;
    this.lastTs = ts;

    if (this.capture === null) {
      if (Math.abs(delta) >= this.triggerW) {
        this.capture = { startTs: ts, samples: [delta] };
      }
      return null;
    }

    this.capture.samples.push(delta);
    if (this.capture.samples.length < this.windowSize) return null;

    const { startTs, samples } = this.capture;
    this.capture = null;
    const deltaW = samples.reduce((a, b) => a + b, 0);
    // A spike that returned to baseline within the window isn't a device
    // switching state (motor inrush, stall retry) — not an event.
    if (Math.abs(deltaW) < this.triggerW) return null;
    return { startTs, waveform: samples, deltaW, direction: deltaW >= 0 ? 'on' : 'off' };
  }
}
