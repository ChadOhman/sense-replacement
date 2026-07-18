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
  volts: number | null;
  hz: number | null;
  devices: LiveDevice[];
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
}

export interface Settings {
  rateCentsPerKwh: number;
  currency: string;
}
