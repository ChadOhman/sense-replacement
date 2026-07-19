/** Core domain types shared between server and web. */

/** A detected device as stored locally (synced from Sense's device list). */
export interface Device {
  id: string;
  name: string;
  type: string | null;
  icon: string | null;
  tags: Record<string, string>;
  isGuess: boolean;
  revoked: boolean;
  firstSeen: number; // epoch seconds UTC
  lastSeen: number; // epoch seconds UTC
}

/** A device currently drawing power, as seen in the live stream. */
export interface LiveDevice {
  id: string;
  name: string;
  icon: string | null;
  w: number;
}

/** One frame of live power data relayed to the browser (~1 Hz). */
export interface LiveFrame {
  ts: number; // epoch seconds UTC
  w: number; // total mains watts
  volts: number | null; // average across legs
  voltageLegs: number[]; // per-leg RMS voltage (empty if unknown)
  hz: number | null;
  devices: LiveDevice[];
}

/** A floating-neutral divergence episode: the two legs moved in opposite
 *  directions simultaneously. Active while endedTs is null. */
export interface NeutralEvent {
  id: number;
  startedTs: number;
  endedTs: number | null;
  maxSpreadVolts: number;
  highLeg: number; // 0-based leg that rose
  peakHighVolts: number;
  peakLowVolts: number;
  nominalVolts: number;
}

/** Rolled-up neutral-health assessment over the trailing 7 days. */
export interface NeutralHealth {
  state: 'ok' | 'suspect' | 'alert';
  events7d: number;
  maxSpread7dVolts: number | null;
}

/** A mains voltage sag (brownout). Active while endedTs is null. */
export interface VoltageEvent {
  id: number;
  startedTs: number;
  endedTs: number | null;
  leg: number; // 0-based leg index with the lowest voltage
  minVolts: number;
  nominalVolts: number; // learned per-leg nominal at event time
}

/** Aggregated whole-home power over one rollup bucket. */
export interface PowerPoint {
  t: number; // bucket start, epoch seconds UTC
  wAvg: number;
  wMin: number;
  wMax: number;
}

/** One day of total usage. */
export interface UsageDay {
  day: string; // YYYY-MM-DD in the configured TZ
  kwh: number;
  cost: number; // in currency units, computed from configured rate
  source: 'trends' | 'rollup';
}

/** One bar in a usage chart at any scale. */
export interface UsageBucket {
  label: string; // e.g. '2026-07-18', '2026-07', '2026'
  kwh: number;
  cost: number;
}

export interface DeviceUsage {
  deviceId: string;
  name: string;
  icon: string | null;
  kwh: number;
  cost: number;
}

export interface DeviceEvent {
  id: number;
  deviceId: string;
  deviceName: string;
  ts: number;
  type: 'on' | 'off';
  watts: number | null;
  source: 'timeline' | 'realtime';
}

export type AuthState = 'ok' | 'needs_mfa' | 'error' | 'unconfigured';

export interface CollectorStatus {
  name: string;
  lastRun: number | null;
  lastSuccess: number | null;
  lastError: string | null;
}

export interface BackfillStatus {
  state: 'idle' | 'running' | 'done';
  cursor: string | null; // YYYY-MM-DD currently being fetched (walking backward)
  daysArchived: number;
}

export interface AppStatus {
  authState: AuthState;
  cloudConnected: boolean; // realtime WS currently healthy
  lastFrameTs: number | null;
  collectors: CollectorStatus[];
  backfill: BackfillStatus;
  dbSizeBytes: number;
  mock: boolean;
  /** Brownout currently in progress, if any. */
  activeBrownout: {
    startedTs: number;
    leg: number;
    minVolts: number;
    nominalVolts: number;
  } | null;
  /** Floating-neutral divergence episode currently in progress, if any. */
  activeNeutralEpisode: {
    startedTs: number;
    maxSpreadVolts: number;
    nominalVolts: number;
  } | null;
}

export interface Settings {
  rateCentsPerKwh: number;
  currency: string;
}
