import type {
  AppStatus,
  Device,
  DeviceEvent,
  DeviceUsage,
  LiveFrame,
  PowerPoint,
  Settings,
  NeutralEvent,
  NeutralHealth,
  UsageBucket,
  VoltageEvent,
} from './types.js';

/** Messages sent server -> browser on the /api/live websocket. */
export type LiveMessage =
  | { kind: 'frame'; frame: LiveFrame }
  | { kind: 'history'; points: PowerPoint[] } // last hour at 30s resolution, sent once on connect
  | { kind: 'status'; cloudConnected: boolean };

/** GET /api/status */
export type StatusResponse = AppStatus;

/** GET /api/history/power?from=&to= (epoch seconds) */
export interface PowerHistoryResponse {
  resolution: number; // seconds: 30 | 300 | 3600
  points: PowerPoint[];
}

export type UsageScale = 'day' | 'week' | 'month' | 'year';

/** GET /api/history/usage?scale=&start= */
export interface UsageResponse {
  scale: UsageScale;
  buckets: UsageBucket[];
  totalKwh: number;
  totalCost: number;
  /** Per-device breakdown over the same range (top devices + 'other'). */
  devices: DeviceUsage[];
}

/** GET /api/devices */
export interface DeviceListItem extends Device {
  nowW: number | null; // from latest live frame, null if off/unknown
  todayKwh: number;
  monthKwh: number;
  monthCost: number;
}
export interface DevicesResponse {
  devices: DeviceListItem[];
}

/** GET /api/devices/:id */
export interface DeviceDetailResponse {
  device: Device;
  nowW: number | null;
  daily: { day: string; kwh: number; cost: number }[]; // last 30 days
  monthly: { month: string; kwh: number; cost: number }[]; // last 12 months
  events: DeviceEvent[]; // most recent 50
}

/** GET /api/events?from=&to=&deviceId= */
export interface EventsResponse {
  events: DeviceEvent[];
}

/** GET /api/voltage-events?from=&to= */
export interface VoltageEventsResponse {
  events: VoltageEvent[]; // newest first; an active event has endedTs === null
}

/** GET /api/neutral-events?from=&to= */
export interface NeutralEventsResponse {
  health: NeutralHealth;
  events: NeutralEvent[]; // newest first; an active episode has endedTs === null
}

/** One rollup bucket of a single leg's voltage. */
export interface VoltagePoint {
  t: number; // bucket start, epoch seconds UTC
  vAvg: number;
  vMin: number;
  vMax: number;
}

/** GET /api/voltage-history?from=&to= — per-leg voltage series. */
export interface VoltageHistoryResponse {
  resolution: number; // seconds: 30 | 300 | 3600
  /** Index = leg (0-based). Empty array if no voltage data in range. */
  legs: VoltagePoint[][];
}

/** GET /api/voltage-summary */
export interface VoltageSummaryResponse {
  /** Live per-leg voltage from the latest frame; empty when no live data. */
  nowVolts: number[];
  /** Reference nominal for the normal band (learned from the data, ~120). */
  nominalVolts: number;
  /** Per-leg stats over the trailing 24 h, from 30s sustained averages. */
  legs: {
    avg: number | null;
    minSustained: number | null;
    maxSustained: number | null;
  }[];
  /** Counts of 5-min buckets in the last 30 days where a leg's voltage left
   *  the ±5% band (per-leg dips/spikes, mutually countable). */
  dips30d: number;
  spikes30d: number;
  /** Most recent out-of-band buckets, newest first (max 20). */
  recent: {
    t: number;
    leg: number;
    kind: 'dip' | 'spike';
    volts: number; // the offending v_min (dip) or v_max (spike)
  }[];
}

/** GET /api/summary */
export interface SummaryResponse {
  todayKwh: number;
  todayCost: number;
  weekKwh: number;
  weekCost: number;
  monthKwh: number;
  monthCost: number;
  alwaysOnW: number | null;
  nowW: number | null;
}

/** GET/PUT /api/settings */
export type SettingsResponse = Settings;

/** GET /api/setup/status */
export interface SetupStatusResponse {
  authState: AppStatus['authState'];
  message: string | null;
}

/** POST /api/setup/mfa */
export interface MfaRequest {
  totp: string;
}
