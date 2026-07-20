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
  w: number; // total consumption watts
  /** Solar production watts; null on monitors without solar CTs. */
  solarW: number | null;
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

/** A motor stall: a cluster of repeated similar-magnitude power spikes
 *  (failed motor start attempts). Active while endedTs is null. */
export interface StallEvent {
  id: number;
  startedTs: number;
  endedTs: number | null;
  spikeCount: number;
  avgSpikeW: number;
  maxSpikeW: number;
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
  /** Average solar production; absent/null on non-solar monitors. */
  solarWAvg?: number | null;
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

/** A flagged deviation of a device's recent usage from its baseline. */
export interface DeviceAnomalyInfo {
  pct: number; // signed fraction, +0.35 = 35% above baseline
  direction: 'up' | 'down';
  recentKwhPerDay: number;
  baselineKwhPerDay: number;
}

/** A gap in the power archive (power outage or collector downtime). */
export interface Outage {
  id: number;
  startedTs: number;
  endedTs: number;
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

/** A generated billing-cycle report. */
export interface CycleReport {
  period: string; // cycle start day
  periodEnd: string;
  generatedTs: number;
  totalKwh: number;
  totalCost: number;
  currency: string;
  prevCycleCost: number | null;
  topDevices: { name: string; kwh: number; cost: number }[];
  powerQuality: { brownouts: number; divergences: number; stalls: number; outages: number };
  anomalies: { name: string; pct: number; direction: 'up' | 'down' }[];
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
  lastBackup: { ts: number; sizeBytes: number } | null;
  /** True once the monitor has ever reported solar production. */
  solar: boolean;
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
  /** Motor stall cluster currently in progress, if any. */
  activeStall: {
    startedTs: number;
    spikeCount: number;
    avgSpikeW: number;
  } | null;
}

export interface Settings {
  rateCentsPerKwh: number;
  currency: string;
}

/** One time-of-use pricing window. Hours are local, [startHour, endHour)
 *  with wraparound (e.g. 21→7). weekdays: 0=Sunday…6=Saturday. months:
 *  1–12, omitted = all year. */
export interface TouPeriod {
  name: string;
  months?: number[];
  weekdays: number[];
  startHour: number;
  endHour: number;
  cents: number;
}

/** Electricity pricing. TOU periods are checked in order; the first match
 *  wins, defaultCents covers unmatched hours. */
export type RatePlan =
  | { type: 'flat'; cents: number }
  | { type: 'tou'; periods: TouPeriod[]; defaultCents: number };

export interface BillingSettings {
  ratePlan: RatePlan;
  /** Day of month (1–28) the utility billing cycle starts. */
  billingCycleDay: number;
}

/** Tunable detection thresholds. */
export interface DetectionSettings {
  /** Motor stall: max fraction of a spike cluster's span the spikes may be
   *  ON in total. Above this the pattern is treated as a thermostat-cycling
   *  appliance (toaster oven, space heater), not a stall. Default 0.25. */
  stallMaxDutyCycle: number;
}

export const DEFAULT_DETECTION_SETTINGS: DetectionSettings = {
  stallMaxDutyCycle: 0.25,
};

/** Coarse alert categories the user can toggle. */
export type AlertKind =
  | 'brownout'
  | 'neutral'
  | 'stall'
  | 'device_finished'
  | 'alwayson_creep'
  | 'device_anomaly';

export interface AlertSettings {
  /** Full ntfy topic URL, e.g. https://ntfy.sh/my-secret-topic. Empty = off. */
  ntfyUrl: string;
  /** Generic JSON webhook URL. Empty = off. */
  webhookUrl: string;
  enabled: Record<AlertKind, boolean>;
  /** Local-time quiet hours [startHour, endHour) during which only
   *  high-priority alerts send. null = no quiet hours. */
  quietHours: { startHour: number; endHour: number } | null;
  /** Devices whose completed runs trigger a "finished" notification. */
  finishedDeviceIds: string[];
  /** Minimum runtime (seconds) for a run to count as "finished". */
  finishedMinRuntimeS: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  ntfyUrl: '',
  webhookUrl: '',
  enabled: {
    brownout: true,
    neutral: true,
    stall: true,
    device_finished: false,
    alwayson_creep: true,
    device_anomaly: true,
  },
  quietHours: null,
  finishedDeviceIds: [],
  finishedMinRuntimeS: 300,
};
