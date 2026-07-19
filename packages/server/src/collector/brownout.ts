/**
 * Pure voltage-sag (brownout) detector. No I/O, no wall-clock reads — time
 * comes in via the `ts` argument on each sample, so this is fully
 * deterministic and unit-testable in isolation from the realtime pipeline.
 */

export interface BrownoutDetectorOptions {
  /** Per-leg nominal voltage to start from. Default 120. */
  nominalVolts?: number;
  /** Sag starts when a leg drops below nominal * startRatio. Default 0.90. */
  startRatio?: number;
  /** Sag ends when ALL legs recover to >= nominal * endRatio (hysteresis). Default 0.92. */
  endRatio?: number;
  /** Sags shorter than this (seconds) are discarded as transients. Default 5. */
  minDurationS?: number;
}

export interface ActiveBrownout {
  /** Epoch seconds of the first sample that tripped the sag. */
  startedTs: number;
  /** 0-based index of the worst (lowest-voltage) leg seen so far during the event. */
  leg: number;
  /** Lowest single-leg voltage seen so far during the event. */
  minVolts: number;
  /** Learned nominal voltage at the time the event started. */
  nominalVolts: number;
}

export interface CompletedBrownout extends ActiveBrownout {
  /** Epoch seconds at which all legs recovered (or the last-seen sample before a gap). */
  endedTs: number;
}

export type BrownoutTransition =
  | { kind: 'started'; active: ActiveBrownout }
  | { kind: 'ended'; event: CompletedBrownout }
  | { kind: 'discarded' } // sag recovered before minDurationS — caller drops any provisional record
  | null; // no state change

const DEFAULT_NOMINAL = 120;
const DEFAULT_START_RATIO = 0.9;
const DEFAULT_END_RATIO = 0.92;
const DEFAULT_MIN_DURATION_S = 5;

/** Glitch floor: a leg reading at or below this is a bad/missing sample, not a real sag. */
const GLITCH_FLOOR_VOLTS = 20;

/** Nominal is only nudged while every leg sits within this band of the current nominal. */
const NOMINAL_LEARNING_BAND = 0.05;
/** EMA smoothing factor applied per in-band sample. */
const NOMINAL_LEARNING_ALPHA = 0.001;
const NOMINAL_MIN = 110;
const NOMINAL_MAX = 130;

/** If the stream gap exceeds this many seconds, close out any active event at the last-seen ts. */
const GAP_TOLERANCE_S = 60;

export class BrownoutDetector {
  private readonly startRatio: number;
  private readonly endRatio: number;
  private readonly minDurationS: number;

  private nominalVolts: number;
  private state: ActiveBrownout | null = null;
  private lastTs: number | null = null;

  constructor(opts: BrownoutDetectorOptions = {}) {
    this.nominalVolts = opts.nominalVolts ?? DEFAULT_NOMINAL;
    this.startRatio = opts.startRatio ?? DEFAULT_START_RATIO;
    this.endRatio = opts.endRatio ?? DEFAULT_END_RATIO;
    this.minDurationS = opts.minDurationS ?? DEFAULT_MIN_DURATION_S;
  }

  get active(): ActiveBrownout | null {
    return this.state;
  }

  get nominal(): number {
    return this.nominalVolts;
  }

  /**
   * Feed one realtime sample. `legs` are per-leg RMS voltages. Empty/glitchy
   * frames are ignored entirely (return null, no state change).
   */
  sample(ts: number, legs: readonly number[]): BrownoutTransition {
    if (legs.length === 0) return null;
    for (const v of legs) {
      if (v <= GLITCH_FLOOR_VOLTS) return null;
    }

    // Stream gap while an event was active: end it at the last-seen ts
    // rather than letting it silently span the dropout, then evaluate this
    // sample fresh (against a clean, non-active state). A single sample()
    // call can only report one transition, so the gap-close takes priority;
    // this sample's own start (if any) is applied to internal state and
    // will surface as 'started' on a later call once observed again, or is
    // simply reflected in `active`/`nominal` immediately.
    if (this.state !== null && this.lastTs !== null && ts - this.lastTs > GAP_TOLERANCE_S) {
      const closed = this.closeActive(this.lastTs);
      this.lastTs = ts;
      this.applyLearning(legs);
      this.evaluateStart(ts, legs);
      return closed;
    }

    this.lastTs = ts;
    this.applyLearning(legs);

    if (this.state === null) {
      return this.evaluateStart(ts, legs);
    }

    // Active event: track the worst leg/voltage seen so far.
    let worstIdx = this.state.leg;
    let worstVolts = this.state.minVolts;
    for (let i = 0; i < legs.length; i++) {
      const v = legs[i]!;
      if (v < worstVolts) {
        worstVolts = v;
        worstIdx = i;
      }
    }
    this.state.leg = worstIdx;
    this.state.minVolts = worstVolts;

    const endThreshold = this.nominalVolts * this.endRatio;
    const allRecovered = legs.every((v) => v >= endThreshold);
    if (allRecovered) {
      return this.closeActive(ts);
    }
    return null;
  }

  /** Only called when no event is currently active. */
  private evaluateStart(ts: number, legs: readonly number[]): BrownoutTransition {
    const startThreshold = this.nominalVolts * this.startRatio;
    let worstIdx = -1;
    let worstVolts = Infinity;
    for (let i = 0; i < legs.length; i++) {
      const v = legs[i]!;
      if (v < startThreshold && v < worstVolts) {
        worstVolts = v;
        worstIdx = i;
      }
    }
    if (worstIdx === -1) return null;

    this.state = {
      startedTs: ts,
      leg: worstIdx,
      minVolts: worstVolts,
      nominalVolts: this.nominalVolts,
    };
    return { kind: 'started', active: this.state };
  }

  /** Close the active event at `ts`, emitting 'ended' or 'discarded' based on duration. */
  private closeActive(ts: number): BrownoutTransition {
    const state = this.state;
    if (state === null) return null;
    this.state = null;
    const durationS = ts - state.startedTs;
    if (durationS < this.minDurationS) {
      return { kind: 'discarded' };
    }
    const event: CompletedBrownout = { ...state, endedTs: ts };
    return { kind: 'ended', event };
  }

  /** Slow EMA of the in-band leg average, only updated when every leg is near nominal. */
  private applyLearning(legs: readonly number[]): void {
    const lowBand = this.nominalVolts * (1 - NOMINAL_LEARNING_BAND);
    const highBand = this.nominalVolts * (1 + NOMINAL_LEARNING_BAND);
    for (const v of legs) {
      if (v < lowBand || v > highBand) return;
    }
    const avg = legs.reduce((sum, v) => sum + v, 0) / legs.length;
    const updated = this.nominalVolts + NOMINAL_LEARNING_ALPHA * (avg - this.nominalVolts);
    this.nominalVolts = Math.min(NOMINAL_MAX, Math.max(NOMINAL_MIN, updated));
  }
}
