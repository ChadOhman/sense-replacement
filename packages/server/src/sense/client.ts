import type { EventEmitter } from 'node:events';
import type { AuthState } from '@sense/shared';
import type {
  SenseDevice,
  SenseRealtimePayload,
  SenseTimeline,
  SenseTrends,
  TrendScale,
} from './types.js';

/**
 * The interface both the real cloud client (rest.ts + realtime.ts via
 * SenseCloudClient) and the fixture-replay mock (mock.ts) implement.
 * Collectors and API routes depend only on this.
 */
export interface SenseClient {
  readonly authState: AuthState;
  /** Human-readable detail for needs_mfa / error states. */
  readonly authMessage: string | null;
  readonly monitorId: number | null;
  readonly monitorTz: string | null;

  /** Authenticate using stored tokens or env credentials. Resolves even in
   *  needs_mfa state (check authState afterwards); rejects on hard failure. */
  start(): Promise<void>;
  submitMfa(totp: string): Promise<void>;
  stop(): Promise<void>;

  getDevices(): Promise<SenseDevice[]>;
  getTrends(scale: TrendScale, startIso: string): Promise<SenseTrends>;
  getTimeline(): Promise<SenseTimeline>;

  /** Realtime feed. Emits:
   *  - 'frame'        (payload: SenseRealtimePayload, ts: number)
   *  - 'connected'
   *  - 'disconnected'
   */
  readonly realtime: SenseRealtimeEvents;
  startRealtime(): void;
  stopRealtime(): void;
  readonly realtimeConnected: boolean;
}

export interface SenseRealtimeEvents extends EventEmitter {
  on(event: 'frame', listener: (payload: SenseRealtimePayload, ts: number) => void): this;
  on(event: 'connected' | 'disconnected', listener: () => void): this;
  emit(event: 'frame', payload: SenseRealtimePayload, ts: number): boolean;
  emit(event: 'connected' | 'disconnected'): boolean;
}
