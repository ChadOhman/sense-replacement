import type {
  AppStatus,
  Device,
  DeviceEvent,
  DeviceUsage,
  LiveFrame,
  PowerPoint,
  Settings,
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
