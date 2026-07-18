import type { AppContext } from '../context.js';
import type { LiveDevice, LiveFrame } from '@sense/shared';
import type { SenseRealtimePayload } from '../sense/types.js';
import { aggregateFrames, bucketStart } from './rollup.js';

const FLUSH_INTERVAL_MS = 30_000;
const LAST_SEEN_THROTTLE_MS = 60_000;
const ON_THRESHOLD_W = 5;
const DEVICE_ROLLUP_MIN_W = 0.5;

export class RealtimeCollector {
  private flushTimer: NodeJS.Timeout | null = null;
  private lastSeenThrottle = new Map<string, number>();
  private prevDevices = new Map<string, number>();
  private readonly insertDeviceStmt;
  private readonly touchLastSeenStmt;
  private readonly insertPowerRollupStmt;
  private readonly insertDevicePowerRollupStmt;
  private readonly insertEventStmt;
  private readonly deviceExistsStmt;

  constructor(private readonly ctx: AppContext) {
    this.insertDeviceStmt = ctx.db.prepare(
      `INSERT OR IGNORE INTO devices (id, name, icon, type, tags_json, is_guess, revoked, first_seen, last_seen)
       VALUES (?, ?, ?, NULL, '{}', 0, 0, ?, ?)`,
    );
    this.touchLastSeenStmt = ctx.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?');
    this.insertPowerRollupStmt = ctx.db.prepare(
      `INSERT OR REPLACE INTO power_rollup (resolution, bucket, w_avg, w_min, w_max, volts, hz, sample_count)
       VALUES (30, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertDevicePowerRollupStmt = ctx.db.prepare(
      `INSERT OR REPLACE INTO device_power_rollup (resolution, bucket, device_id, w_avg, sample_count)
       VALUES (30, ?, ?, ?, ?)`,
    );
    this.insertEventStmt = ctx.db.prepare(
      `INSERT OR IGNORE INTO events (device_id, ts, type, watts, source) VALUES (?, ?, ?, ?, 'realtime')`,
    );
    this.deviceExistsStmt = ctx.db.prepare('SELECT 1 FROM devices WHERE id = ?');
  }

  start(): void {
    this.ctx.sense.realtime.on('frame', this.onFrame);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    this.ctx.sense.realtime.removeListener('frame', this.onFrame);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  private onFrame = (payload: SenseRealtimePayload, ts: number): void => {
    const volts =
      payload.voltage && payload.voltage.length > 0
        ? payload.voltage.reduce((a, b) => a + b, 0) / payload.voltage.length
        : null;
    const devices: LiveDevice[] = payload.devices.map((d) => ({
      id: d.id,
      name: d.name ?? d.id,
      icon: d.icon ?? null,
      w: d.w,
    }));
    const frame: LiveFrame = { ts, w: payload.w, volts, hz: payload.hz ?? null, devices };
    this.ctx.ring.push(frame);
    this.ensureDevices(devices, ts);
    this.detectTransitions(devices, ts);
  };

  private ensureDevices(devices: LiveDevice[], ts: number): void {
    for (const d of devices) {
      const lastTouch = this.lastSeenThrottle.get(d.id) ?? 0;
      const nowMs = ts * 1000;
      if (nowMs - lastTouch < LAST_SEEN_THROTTLE_MS) continue;
      this.insertDeviceStmt.run(d.id, d.name, d.icon, ts, ts);
      this.touchLastSeenStmt.run(ts, d.id);
      this.lastSeenThrottle.set(d.id, nowMs);
    }
  }

  private detectTransitions(devices: LiveDevice[], ts: number): void {
    const seenNow = new Map(devices.map((d) => [d.id, d.w] as const));
    for (const [id, w] of seenNow) {
      const wasOn = (this.prevDevices.get(id) ?? 0) > ON_THRESHOLD_W;
      if (!wasOn && w > ON_THRESHOLD_W) this.recordEvent(id, ts, 'on', w);
    }
    for (const [id, prevW] of this.prevDevices) {
      const wasOn = prevW > ON_THRESHOLD_W;
      const isOn = (seenNow.get(id) ?? 0) > ON_THRESHOLD_W;
      if (wasOn && !isOn) this.recordEvent(id, ts, 'off', seenNow.get(id) ?? null);
    }
    const next = new Map<string, number>();
    for (const [id, w] of seenNow) next.set(id, w);
    this.prevDevices = next;
  }

  private recordEvent(deviceId: string, ts: number, type: 'on' | 'off', watts: number | null): void {
    if (!this.deviceExistsStmt.get(deviceId)) return;
    this.insertEventStmt.run(deviceId, ts, type, watts);
  }

  private flush(): void {
    try {
      const now = Math.floor(Date.now() / 1000);
      const bStart = bucketStart(now - 30, 30); // just-completed bucket
      const frames = this.ctx.ring.range(bStart, bStart + 30);
      const agg = aggregateFrames([...frames]);
      if (!agg) return;
      this.ctx.db.transaction(() => {
        this.insertPowerRollupStmt.run(bStart, agg.wAvg, agg.wMin, agg.wMax, agg.volts, agg.hz, agg.sampleCount);
        for (const [deviceId, { wAvg }] of agg.perDevice) {
          if (wAvg <= DEVICE_ROLLUP_MIN_W) continue;
          if (!this.deviceExistsStmt.get(deviceId)) continue;
          this.insertDevicePowerRollupStmt.run(bStart, deviceId, wAvg, agg.sampleCount);
        }
      })();
    } catch (err) {
      this.ctx.log(`realtime flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
