/**
 * Pure motor-stall detector operating on the 1 Hz whole-home wattage
 * stream. No I/O, no wall-clock reads — time comes in via the `ts`
 * argument on each sample, so this is fully deterministic and
 * unit-testable in isolation from the realtime pipeline.
 *
 * A healthy motor start is one brief inrush spike followed by steady
 * draw. A stalling motor (typically a 240V AC compressor) repeatedly
 * attempts to start: it draws locked-rotor current (a large spike,
 * hundreds to thousands of watts), thermal/overload protection cuts it
 * after seconds, it cools, and it retries — producing repeated
 * similar-magnitude spikes minutes apart. This detector clusters
 * short-lived power spikes by magnitude and cadence, and flags a
 * cluster once enough of them accumulate.
 */

export interface StallDetectorOptions {
  /** Rise above baseline that counts as a spike. Default 800. */
  minSpikeW?: number;
  /** Plateaus longer than this (seconds) are normal appliance turn-ons, not stalls. Default 30. */
  maxSpikeDurationS?: number;
  /** Spikes within this fraction of the cluster's average magnitude match. Default 0.3. */
  magnitudeTolerance?: number;
  /** Max gap (seconds) between successive spikes in one cluster. Default 300. */
  retryWindowS?: number;
  /** Number of clustered spikes at which a cluster becomes a stall event. Default 3. */
  spikesToFlag?: number;
}

export interface ActiveStall {
  /** First spike's start. */
  startedTs: number;
  /** Last spike's end. */
  lastSpikeTs: number;
  spikeCount: number;
  /** Running average of spike magnitudes (above baseline). */
  avgSpikeW: number;
  maxSpikeW: number;
}

export interface CompletedStall extends ActiveStall {
  /** The end ts of the cluster's last spike (closed after retryWindowS of silence). */
  endedTs: number;
}

export type StallTransition =
  | { kind: 'detected'; active: ActiveStall } // cluster just reached spikesToFlag
  | { kind: 'spike'; active: ActiveStall } // an already-flagged cluster got another spike (caller updates the row)
  | { kind: 'ended'; event: CompletedStall } // a flagged cluster timed out (closed)
  | null;

const DEFAULT_MIN_SPIKE_W = 800;
const DEFAULT_MAX_SPIKE_DURATION_S = 30;
const DEFAULT_MAGNITUDE_TOLERANCE = 0.3;
const DEFAULT_RETRY_WINDOW_S = 300;
const DEFAULT_SPIKES_TO_FLAG = 3;

/** EMA smoothing factor applied to the baseline while not inside a spike. */
const BASELINE_ALPHA = 0.05;

/** A spike ends once w drops back to baseline + this fraction of (peak - baseline). */
const SPIKE_END_RATIO = 0.25;

/** ts jump larger than this while inside a spike discards the in-flight spike. */
const GAP_TOLERANCE_S = 60;

/** A candidate spike still being tracked, not yet resolved into a completed candidate. */
interface InFlightSpike {
  startTs: number;
  peak: number;
  /** Baseline at the moment the spike started; frozen for the life of the spike. */
  baselineAtEntry: number;
}

/** A resolved spike, ready to be matched against (or start) a cluster. */
interface StallCandidate {
  startTs: number;
  endTs: number;
  magnitude: number;
}

function withinTolerance(magnitude: number, avg: number, tolerance: number): boolean {
  return Math.abs(magnitude - avg) <= tolerance * avg;
}

export class MotorStallDetector {
  private readonly minSpikeW: number;
  private readonly maxSpikeDurationS: number;
  private readonly magnitudeTolerance: number;
  private readonly retryWindowS: number;
  private readonly spikesToFlag: number;

  /** EMA baseline; null until the first sample seeds it. */
  private baseline: number | null = null;
  private lastTs: number | null = null;
  private spike: InFlightSpike | null = null;

  private cluster: ActiveStall | null = null;
  private clusterFlagged = false;

  constructor(opts: StallDetectorOptions = {}) {
    this.minSpikeW = opts.minSpikeW ?? DEFAULT_MIN_SPIKE_W;
    this.maxSpikeDurationS = opts.maxSpikeDurationS ?? DEFAULT_MAX_SPIKE_DURATION_S;
    this.magnitudeTolerance = opts.magnitudeTolerance ?? DEFAULT_MAGNITUDE_TOLERANCE;
    this.retryWindowS = opts.retryWindowS ?? DEFAULT_RETRY_WINDOW_S;
    this.spikesToFlag = opts.spikesToFlag ?? DEFAULT_SPIKES_TO_FLAG;
  }

  /** Non-null only once a cluster has been flagged ('detected' has fired for it). */
  get active(): ActiveStall | null {
    return this.clusterFlagged ? this.cluster : null;
  }

  /**
   * Feed one whole-home power sample (watts). Junk samples (negative or
   * non-finite wattage) are skipped entirely: return null, no state change.
   */
  sample(ts: number, w: number): StallTransition {
    if (w < 0 || !Number.isFinite(w)) return null;

    if (this.baseline === null) {
      this.baseline = w;
      this.lastTs = ts;
      return null;
    }

    // Stream gap while a spike was in flight: discard it outright rather
    // than fabricating a duration across the dropout, then evaluate this
    // sample fresh (against a clean, non-spiking state).
    const prevTs = this.lastTs;
    if (this.spike !== null && prevTs !== null && ts - prevTs > GAP_TOLERANCE_S) {
      this.spike = null;
    }
    this.lastTs = ts;

    if (this.spike !== null) {
      return this.sampleInFlight(ts, w);
    }
    return this.sampleBaseline(ts, w);
  }

  /** Called when no spike is currently in flight. */
  private sampleBaseline(ts: number, w: number): StallTransition {
    // A flagged cluster's cadence is checked as time passes on every
    // sample, not only when a new candidate arrives — otherwise a cluster
    // with no further retries would never close.
    const timeoutTransition = this.checkClusterTimeout(ts);

    const baseline = this.baseline!;
    if (w - baseline >= this.minSpikeW) {
      // Enter the spike using the current (pre-update) baseline; the
      // sample that trips the spike does not itself nudge the baseline.
      this.spike = { startTs: ts, peak: w, baselineAtEntry: baseline };
    } else {
      this.baseline = baseline + BASELINE_ALPHA * (w - baseline);
    }

    return timeoutTransition;
  }

  /** Called when a spike is currently in flight. */
  private sampleInFlight(ts: number, w: number): StallTransition {
    const spike = this.spike!;
    if (w > spike.peak) spike.peak = w;

    const durationS = ts - spike.startTs;
    if (durationS > this.maxSpikeDurationS) {
      // Still elevated after maxSpikeDurationS: a normal appliance turn-on,
      // not a stall. Abandon the spike and re-seed the baseline to the
      // current draw so the new steady load doesn't look like an ongoing
      // spike (a slow EMA alone would take far too long to catch up).
      this.baseline = w;
      this.spike = null;
      return null;
    }

    const endThreshold = spike.baselineAtEntry + SPIKE_END_RATIO * (spike.peak - spike.baselineAtEntry);
    if (w <= endThreshold) {
      const candidate: StallCandidate = {
        startTs: spike.startTs,
        endTs: ts,
        magnitude: spike.peak - spike.baselineAtEntry,
      };
      this.spike = null;
      return this.processCandidate(candidate);
    }

    return null;
  }

  /** Check whether a flagged cluster has gone quiet for longer than retryWindowS. */
  private checkClusterTimeout(ts: number): StallTransition {
    if (this.cluster === null) return null;
    const gap = ts - this.cluster.lastSpikeTs;
    if (gap <= this.retryWindowS) return null;

    // Unflagged clusters (below spikesToFlag) close silently.
    const transition: StallTransition = this.clusterFlagged
      ? { kind: 'ended', event: { ...this.cluster, endedTs: this.cluster.lastSpikeTs } }
      : null;
    this.cluster = null;
    this.clusterFlagged = false;
    return transition;
  }

  /** Match (or start) a cluster for a just-resolved candidate spike. */
  private processCandidate(candidate: StallCandidate): StallTransition {
    if (this.cluster === null) {
      this.startCluster(candidate);
      return this.checkFlag();
    }

    const gap = candidate.startTs - this.cluster.lastSpikeTs;
    const matches = gap <= this.retryWindowS && withinTolerance(candidate.magnitude, this.cluster.avgSpikeW, this.magnitudeTolerance);

    if (matches) {
      this.extendCluster(candidate);
      return this.checkFlag();
    }

    // Non-matching candidate: the old cluster is done (only one transition
    // per sample() call, so a close here takes priority over anything the
    // fresh cluster might immediately report); the new cluster still forms
    // internally and will surface on a later call, matching the gap-handling
    // convention in brownout.ts/neutral.ts.
    const closeTransition: StallTransition = this.clusterFlagged
      ? { kind: 'ended', event: { ...this.cluster, endedTs: this.cluster.lastSpikeTs } }
      : null;
    this.startCluster(candidate);
    if (closeTransition !== null) return closeTransition;
    return this.checkFlag();
  }

  private startCluster(candidate: StallCandidate): void {
    this.cluster = {
      startedTs: candidate.startTs,
      lastSpikeTs: candidate.endTs,
      spikeCount: 1,
      avgSpikeW: candidate.magnitude,
      maxSpikeW: candidate.magnitude,
    };
    this.clusterFlagged = false;
  }

  private extendCluster(candidate: StallCandidate): void {
    const c = this.cluster!;
    const newCount = c.spikeCount + 1;
    c.avgSpikeW = c.avgSpikeW + (candidate.magnitude - c.avgSpikeW) / newCount;
    c.maxSpikeW = Math.max(c.maxSpikeW, candidate.magnitude);
    c.spikeCount = newCount;
    c.lastSpikeTs = candidate.endTs;
  }

  /** Emits 'detected' the moment a cluster reaches spikesToFlag, 'spike' on every match thereafter. */
  private checkFlag(): StallTransition {
    const c = this.cluster;
    if (c === null) return null;
    if (!this.clusterFlagged) {
      if (c.spikeCount >= this.spikesToFlag) {
        this.clusterFlagged = true;
        return { kind: 'detected', active: c };
      }
      return null;
    }
    return { kind: 'spike', active: c };
  }
}
