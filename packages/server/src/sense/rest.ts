import type { AuthState } from '@sense/shared';
import {
  API_BASE,
  COMMON_HEADERS,
  MfaRequiredError,
  SenseAuthError,
  authenticate,
  completeMfa,
  renewToken,
  type TokenStore,
} from './auth.js';
import { SenseRealtimeSocket } from './realtime.js';
import {
  senseDeviceSchema,
  senseTimelineSchema,
  senseTrendsSchema,
  type SenseDevice,
  type SenseTimeline,
  type SenseTrends,
  type StoredTokens,
  type TrendScale,
} from './types.js';
import type { SenseClient, SenseRealtimeEvents } from './client.js';
import { z } from 'zod';

/** Token bucket: 1 req/s sustained, burst of 5. */
class RateLimiter {
  private tokens = 5;
  private lastRefill = Date.now();

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(5, this.tokens + (now - this.lastRefill) / 1000);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, (1 - this.tokens) * 1000));
    }
  }
}

export interface SenseCloudClientOptions {
  email: string;
  password: string;
  tokenStore: TokenStore;
  realtimeMode: 'persistent' | 'duty-cycle';
  log: (msg: string) => void;
}

export class SenseCloudClient implements SenseClient {
  private tokens: StoredTokens | null = null;
  private pendingMfaToken: string | null = null;
  private _authState: AuthState = 'unconfigured';
  private _authMessage: string | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private readonly limiter = new RateLimiter();
  private readonly socket: SenseRealtimeSocket;

  constructor(private readonly opts: SenseCloudClientOptions) {
    this.socket = new SenseRealtimeSocket({
      getMonitorId: () => this.tokens?.monitorId ?? null,
      getAccessToken: () => this.tokens?.accessToken ?? null,
      onAuthFailure: () => this.refreshAuth(),
      mode: opts.realtimeMode,
      log: opts.log,
    });
  }

  get authState(): AuthState {
    return this._authState;
  }
  get authMessage(): string | null {
    return this._authMessage;
  }
  get monitorId(): number | null {
    return this.tokens?.monitorId ?? null;
  }
  get monitorTz(): string | null {
    return this.tokens?.monitorTz ?? null;
  }
  get realtime(): SenseRealtimeEvents {
    return this.socket.events;
  }
  get realtimeConnected(): boolean {
    return this.socket.isConnected;
  }

  async start(): Promise<void> {
    const stored = this.opts.tokenStore.load();
    if (stored) {
      this.tokens = stored;
      this._authState = 'ok';
      this.opts.log('sense: using stored tokens');
      return;
    }
    await this.passwordAuth();
  }

  private async passwordAuth(): Promise<void> {
    try {
      this.tokens = await authenticate(this.opts.email, this.opts.password);
      this.opts.tokenStore.save(this.tokens);
      this._authState = 'ok';
      this._authMessage = null;
      this.opts.log('sense: authenticated with credentials');
    } catch (err) {
      if (err instanceof MfaRequiredError) {
        this.pendingMfaToken = err.mfaToken;
        this._authState = 'needs_mfa';
        this._authMessage = 'Enter the 6-digit code from your authenticator app';
        this.opts.log('sense: MFA required — waiting for code via web UI');
        return;
      }
      this._authState = 'error';
      this._authMessage = (err as Error).message;
      throw err;
    }
  }

  async submitMfa(totp: string): Promise<void> {
    if (!this.pendingMfaToken) {
      throw new SenseAuthError('No MFA challenge is pending');
    }
    this.tokens = await completeMfa(this.pendingMfaToken, totp);
    this.opts.tokenStore.save(this.tokens);
    this.pendingMfaToken = null;
    this._authState = 'ok';
    this._authMessage = null;
    this.opts.log('sense: MFA complete, tokens stored');
  }

  async stop(): Promise<void> {
    this.socket.stop();
  }

  startRealtime(): void {
    this.socket.start();
  }
  stopRealtime(): void {
    this.socket.stop();
  }

  /** Single-flight: renew → full re-auth → needs_mfa. */
  private refreshAuth(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      try {
        if (this.tokens?.refreshToken) {
          try {
            this.tokens = await renewToken(this.tokens);
            this.opts.tokenStore.save(this.tokens);
            this._authState = 'ok';
            this._authMessage = null;
            this.opts.log('sense: access token renewed');
            return;
          } catch (err) {
            this.opts.log(`sense: token renewal failed (${(err as Error).message}), re-authenticating`);
          }
        }
        this.opts.tokenStore.clear();
        this.tokens = null;
        await this.passwordAuth();
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private async request<T>(
    path: string,
    schema: { parse: (data: unknown) => T },
    retried = false,
  ): Promise<T> {
    if (this._authState === 'needs_mfa') {
      throw new SenseAuthError('Waiting for MFA code');
    }
    if (!this.tokens) {
      throw new SenseAuthError('Not authenticated');
    }
    await this.limiter.acquire();
    const res = await fetch(`${API_BASE}/${path}`, {
      headers: {
        ...COMMON_HEADERS,
        Authorization: `bearer ${this.tokens.accessToken}`,
      },
    });
    if (res.status === 401 && !retried) {
      await this.refreshAuth();
      return this.request(path, schema, true);
    }
    if (!res.ok) {
      throw new Error(`Sense API ${path} failed: HTTP ${res.status}`);
    }
    return schema.parse(await res.json());
  }

  async getDevices(): Promise<SenseDevice[]> {
    const id = this.requireMonitorId();
    return this.request(`app/monitors/${id}/devices`, z.array(senseDeviceSchema));
  }

  async getTrends(scale: TrendScale, startIso: string): Promise<SenseTrends> {
    const id = this.requireMonitorId();
    const params = new URLSearchParams({
      monitor_id: String(id),
      scale,
      start: startIso,
    });
    return this.request(`app/history/trends?${params.toString()}`, senseTrendsSchema);
  }

  async getTimeline(): Promise<SenseTimeline> {
    if (!this.tokens) throw new SenseAuthError('Not authenticated');
    return this.request(
      `users/${this.tokens.userId}/timeline?n_items=30`,
      senseTimelineSchema,
    );
  }

  private requireMonitorId(): number {
    const id = this.monitorId;
    if (id === null) throw new SenseAuthError('Not authenticated');
    return id;
  }
}
