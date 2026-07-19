/**
 * Pure floating-neutral (leg divergence) detector. No I/O, no wall-clock
 * reads — time comes in via the `ts` argument on each sample, so this is
 * fully deterministic and unit-testable in isolation from the realtime
 * pipeline.
 *
 * In North American split-phase service, a healthy system keeps both 120V
 * legs balanced — they drift together. With a floating (loose/broken)
 * neutral, the legs become anti-correlated: as load switches, one leg's
 * voltage rises while the other falls (their sum stays roughly nominal*2).
 * This detector looks for sustained episodes where the legs deviate from
 * nominal in opposite directions, which a plain brownout (both legs sagging
 * together) will never trigger.
 */

export interface NeutralDetectorOptions {
  /** Per-leg nominal voltage to start from. Default 120. */
  nominalVolts?: number;
  /** Episode starts when one leg >= nominal + divergeVolts AND the other <= nominal - divergeVolts. Default 3. */
  divergeVolts?: number;
  /** Episode ends when the divergence condition (evaluated at endVolts) no longer holds for either direction (hysteresis). Default 2. */
  endVolts?: number;
  /** Episodes shorter than this (seconds) are discarded as transients. Default 3. */
  minDurationS?: number;
}

export interface ActiveNeutralEpisode {
  /** Epoch seconds of the first sample that tripped the divergence. */
  startedTs: number;
  /** Max of |legHigh - legLow| seen so far during the episode. */
  maxSpreadVolts: number;
  /** 0-based index of the leg that was HIGH at max spread. */
  highLeg: number;
  /** That leg's voltage at max spread. */
  peakHighVolts: number;
  /** The low leg's voltage at max spread. */
  peakLowVolts: number;
  /** Learned nominal voltage at the time the episode started. */
  nominalVolts: number;
}

export interface CompletedNeutralEpisode extends ActiveNeutralEpisode {
  /** Epoch seconds at which the divergence recovered (or the last-seen ts before a gap). */
  endedTs: number;
}

export type NeutralTransition =
  | { kind: 'started'; active: ActiveNeutralEpisode }
  | { kind: 'ended'; episode: CompletedNeutralEpisode }
  | { kind: 'discarded' } // episode recovered before minDurationS — caller drops any provisional record
  | null; // no state change

const DEFAULT_NOMINAL = 120;
const DEFAULT_DIVERGE_VOLTS = 3;
const DEFAULT_END_VOLTS = 2;
const DEFAULT_MIN_DURATION_S = 3;

/** Glitch floor: a leg reading at or below this is a bad/missing sample, not a real reading. */
const GLITCH_FLOOR_VOLTS = 20;

/** Nominal is only nudged while every leg sits within this band of the current nominal. */
const NOMINAL_LEARNING_BAND = 0.05;
/** EMA smoothing factor applied per in-band sample. */
const NOMINAL_LEARNING_ALPHA = 0.001;
const NOMINAL_MIN = 110;
const NOMINAL_MAX = 130;

/** If the stream gap exceeds this many seconds, close out any active episode at the last-seen ts. */
const GAP_TOLERANCE_S = 60;

/** Result of checking whether two legs are anti-correlated at a given threshold. */
interface DivergenceCheck {
  highLeg: number;
  highVolts: number;
  lowVolts: number;
}

/**
 * Strict anti-correlation check: one leg >= nominal + thresholdVolts AND the
 * other <= nominal - thresholdVolts. Both legs merely sagging (or both
 * rising) together does not qualify — that is a brownout/surge, not a
 * floating neutral.
 */
function checkDivergence(
  legs: readonly [number, number],
  nominal: number,
  thresholdVolts: number,
): DivergenceCheck | null {
  const [a, b] = legs;
  if (a >= nominal + thresholdVolts && b <= nominal - thresholdVolts) {
    return { highLeg: 0, highVolts: a, lowVolts: b };
  }
  if (b >= nominal + thresholdVolts && a <= nominal - thresholdVolts) {
    return { highLeg: 1, highVolts: b, lowVolts: a };
  }
  return null;
}

export class FloatingNeutralDetector {
  private readonly divergeVolts: number;
  private readonly endVolts: number;
  private readonly minDurationS: number;

  private nominalVolts: number;
  private state: ActiveNeutralEpisode | null = null;
  private lastTs: number | null = null;

  constructor(opts: NeutralDetectorOptions = {}) {
    this.nominalVolts = opts.nominalVolts ?? DEFAULT_NOMINAL;
    this.divergeVolts = opts.divergeVolts ?? DEFAULT_DIVERGE_VOLTS;
    this.endVolts = opts.endVolts ?? DEFAULT_END_VOLTS;
    this.minDurationS = opts.minDurationS ?? DEFAULT_MIN_DURATION_S;
  }

  get active(): ActiveNeutralEpisode | null {
    return this.state;
  }

  get nominal(): number {
    return this.nominalVolts;
  }

  /**
   * Feed one realtime sample. `legs` are per-leg RMS voltages. Requires
   * exactly 2 usable legs — samples with fewer/more legs or any leg <= 20V
   * (glitch) are skipped entirely (return null, no state change).
   */
  sample(ts: number, legs: readonly number[]): NeutralTransition {
    if (legs.length !== 2) return null;
    for (const v of legs) {
      if (v <= GLITCH_FLOOR_VOLTS) return null;
    }
    const pair: readonly [number, number] = [legs[0]!, legs[1]!];

    // Stream gap while an episode was active: close it at the last-seen ts
    // rather than letting it silently span the dropout, then evaluate this
    // sample fresh (against a clean, non-active state). A single sample()
    // call can only report one transition, so the gap-close takes priority;
    // this sample's own start (if any) is applied to internal state and
    // will surface as 'started' on a later call once observed again, or is
    // simply reflected in `active`/`nominal` immediately.
    if (this.state !== null && this.lastTs !== null && ts - this.lastTs > GAP_TOLERANCE_S) {
      const closed = this.closeActive(this.lastTs);
      this.lastTs = ts;
      this.applyLearning(pair);
      this.evaluateStart(ts, pair);
      return closed;
    }

    this.lastTs = ts;
    this.applyLearning(pair);

    if (this.state === null) {
      return this.evaluateStart(ts, pair);
    }

    // Active episode: track the largest instantaneous spread seen so far,
    // independent of which direction (if any) currently qualifies as
    // divergent — this is what maxSpreadVolts/peak* report.
    const highLeg = pair[0] >= pair[1] ? 0 : 1;
    const highVolts = highLeg === 0 ? pair[0] : pair[1];
    const lowVolts = highLeg === 0 ? pair[1] : pair[0];
    const spread = highVolts - lowVolts;
    if (spread > this.state.maxSpreadVolts) {
      this.state.maxSpreadVolts = spread;
      this.state.highLeg = highLeg;
      this.state.peakHighVolts = highVolts;
      this.state.peakLowVolts = lowVolts;
    }

    const stillDivergent = checkDivergence(pair, this.nominalVolts, this.endVolts) !== null;
    if (!stillDivergent) {
      return this.closeActive(ts);
    }
    return null;
  }

  /** Only called when no episode is currently active. */
  private evaluateStart(ts: number, legs: readonly [number, number]): NeutralTransition {
    const div = checkDivergence(legs, this.nominalVolts, this.divergeVolts);
    if (div === null) return null;

    const spread = div.highVolts - div.lowVolts;
    this.state = {
      startedTs: ts,
      maxSpreadVolts: spread,
      highLeg: div.highLeg,
      peakHighVolts: div.highVolts,
      peakLowVolts: div.lowVolts,
      nominalVolts: this.nominalVolts,
    };
    return { kind: 'started', active: this.state };
  }

  /** Close the active episode at `ts`, emitting 'ended' or 'discarded' based on duration. */
  private closeActive(ts: number): NeutralTransition {
    const state = this.state;
    if (state === null) return null;
    this.state = null;
    const durationS = ts - state.startedTs;
    if (durationS < this.minDurationS) {
      return { kind: 'discarded' };
    }
    const episode: CompletedNeutralEpisode = { ...state, endedTs: ts };
    return { kind: 'ended', episode };
  }

  /** Slow EMA of the in-band leg average, only updated when both legs are near nominal. */
  private applyLearning(legs: readonly [number, number]): void {
    const lowBand = this.nominalVolts * (1 - NOMINAL_LEARNING_BAND);
    const highBand = this.nominalVolts * (1 + NOMINAL_LEARNING_BAND);
    for (const v of legs) {
      if (v < lowBand || v > highBand) return;
    }
    const avg = (legs[0] + legs[1]) / 2;
    const updated = this.nominalVolts + NOMINAL_LEARNING_ALPHA * (avg - this.nominalVolts);
    this.nominalVolts = Math.min(NOMINAL_MAX, Math.max(NOMINAL_MIN, updated));
  }
}
