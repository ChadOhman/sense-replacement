import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { senseRealtimePayloadSchema, senseWsMessageSchema } from './types.js';
import type { SenseRealtimeEvents } from './client.js';

const REALTIME_BASE = 'wss://clientrt.sense.com/monitors';
const WATCHDOG_MS = 30_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const BACKOFF_RESET_AFTER_MS = 60_000;

export interface RealtimeOptions {
  getMonitorId: () => number | null;
  getAccessToken: () => string | null;
  /** Called on 401-ish connection failures so the owner can refresh tokens. */
  onAuthFailure: () => Promise<void>;
  mode: 'persistent' | 'duty-cycle';
  log: (msg: string) => void;
}

/**
 * Maintains one websocket to Sense's realtime feed with exponential backoff,
 * a stale-stream watchdog, and an optional duty-cycle mode (50s on / 10s off).
 */
export class SenseRealtimeSocket {
  readonly events: SenseRealtimeEvents = new EventEmitter();
  private ws: WebSocket | null = null;
  private running = false;
  private connected = false;
  private backoffMs = BACKOFF_MIN_MS;
  private connectedSince = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private dutyCycleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: RealtimeOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    this.teardown();
  }

  private clearTimers(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.dutyCycleTimer) clearTimeout(this.dutyCycleTimer);
    this.watchdog = null;
    this.reconnectTimer = null;
    this.dutyCycleTimer = null;
  }

  private teardown(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
    if (this.connected) {
      this.connected = false;
      this.events.emit('disconnected');
    }
  }

  private connect(): void {
    if (!this.running) return;
    const monitorId = this.opts.getMonitorId();
    const token = this.opts.getAccessToken();
    if (monitorId === null || token === null) {
      this.scheduleReconnect();
      return;
    }
    const url = `${REALTIME_BASE}/${monitorId}/realtimefeed?access_token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.connectedSince = Date.now();
      this.connected = true;
      this.events.emit('connected');
      this.armWatchdog();
      if (this.opts.mode === 'duty-cycle') {
        this.dutyCycleTimer = setTimeout(() => {
          this.opts.log('realtime: duty-cycle pause');
          this.teardown();
          this.reconnectTimer = setTimeout(() => this.connect(), 10_000);
        }, 50_000);
      }
    });

    ws.on('message', (data) => {
      this.armWatchdog();
      if (Date.now() - this.connectedSince > BACKOFF_RESET_AFTER_MS) {
        this.backoffMs = BACKOFF_MIN_MS;
      }
      try {
        const msg = senseWsMessageSchema.parse(JSON.parse(String(data)));
        if (msg.type === 'realtime_update') {
          const payload = senseRealtimePayloadSchema.safeParse(msg.payload);
          if (payload.success) {
            this.events.emit('frame', payload.data, Math.floor(Date.now() / 1000));
          }
        } else if (msg.type === 'error') {
          this.opts.log(`realtime: server error frame: ${JSON.stringify(msg.payload).slice(0, 200)}`);
        }
      } catch {
        /* unparseable frame — ignore */
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      this.opts.log(`realtime: connect rejected with HTTP ${status}`);
      if (status === 401 || status === 403) {
        void this.opts.onAuthFailure().catch(() => undefined);
      }
      this.teardown();
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.opts.log(`realtime: socket error: ${(err as Error).message}`);
    });

    ws.on('close', () => {
      const wasDutyCyclePause = this.dutyCycleTimer === null && this.opts.mode === 'duty-cycle';
      this.teardown();
      if (this.running && !this.reconnectTimer && !wasDutyCyclePause) {
        this.scheduleReconnect();
      }
    });
  }

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.opts.log('realtime: no frames for 30s, forcing reconnect');
      this.teardown();
      this.scheduleReconnect();
    }, WATCHDOG_MS);
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    const jitter = this.backoffMs * (0.8 + 0.4 * ((Date.now() % 1000) / 1000));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jitter);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }
}
