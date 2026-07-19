import type { AppContext } from '../context.js';
import type { LiveDevice, LiveFrame } from '@sense/shared';
import type { SenseRealtimePayload } from '../sense/types.js';
import { aggregateFrames, bucketStart } from './rollup.js';
import { BrownoutDetector, type ActiveBrownout } from './brownout.js';
import { FloatingNeutralDetector, type ActiveNeutralEpisode } from './neutral.js';

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
  private readonly insertVoltageEventStmt;
  private readonly endVoltageEventStmt;
  private readonly deleteVoltageEventStmt;
  private readonly brownouts = new BrownoutDetector();
  private activeVoltageEventId: number | bigint | null = null;
  private readonly neutral = new FloatingNeutralDetector();
  private activeNeutralEventId: number | bigint | null = null;
  private readonly insertNeutralEventStmt;
  private readonly endNeutralEventStmt;
  private readonly deleteNeutralEventStmt;

  get activeBrownout(): ActiveBrownout | null {
    return this.brownouts.active;
  }

  get activeNeutralEpisode(): ActiveNeutralEpisode | null {
    return this.neutral.active;
  }

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
    this.insertVoltageEventStmt = ctx.db.prepare(
      'INSERT INTO voltage_events (started_ts, ended_ts, leg, min_volts, nominal_volts) VALUES (?, NULL, ?, ?, ?)',
    );
    this.endVoltageEventStmt = ctx.db.prepare(
      'UPDATE voltage_events SET ended_ts = ?, leg = ?, min_volts = ?, nominal_volts = ? WHERE id = ?',
    );
    this.deleteVoltageEventStmt = ctx.db.prepare('DELETE FROM voltage_events WHERE id = ?');
    this.insertNeutralEventStmt = ctx.db.prepare(
      `INSERT INTO neutral_events (started_ts, ended_ts, max_spread_volts, high_leg, peak_high_volts, peak_low_volts, nominal_volts)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    );
    this.endNeutralEventStmt = ctx.db.prepare(
      `UPDATE neutral_events SET ended_ts = ?, max_spread_volts = ?, high_leg = ?, peak_high_volts = ?, peak_low_volts = ?, nominal_volts = ?
       WHERE id = ?`,
    );
    this.deleteNeutralEventStmt = ctx.db.prepare('DELETE FROM neutral_events WHERE id = ?');
    // A crash mid-event leaves a dangling open row; close it with unknown
    // duration rather than letting it read as "active" forever.
    ctx.db.prepare('UPDATE voltage_events SET ended_ts = started_ts WHERE ended_ts IS NULL').run();
    ctx.db.prepare('UPDATE neutral_events SET ended_ts = started_ts WHERE ended_ts IS NULL').run();
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
    const frame: LiveFrame = {
      ts,
      w: payload.w,
      volts,
      voltageLegs: payload.voltage ?? [],
      hz: payload.hz ?? null,
      devices,
    };
    this.ctx.ring.push(frame);
    this.ensureDevices(devices, ts);
    this.detectTransitions(devices, ts);
    this.trackVoltage(ts, payload.voltage ?? []);
    this.trackNeutral(ts, payload.voltage ?? []);
  };

  private trackNeutral(ts: number, legs: number[]): void {
    try {
      const transition = this.neutral.sample(ts, legs);
      if (!transition) {
        const a = this.neutral.active;
        if (a && this.activeNeutralEventId === null) {
          const res = this.insertNeutralEventStmt.run(
            a.startedTs, a.maxSpreadVolts, a.highLeg, a.peakHighVolts, a.peakLowVolts, a.nominalVolts,
          );
          this.activeNeutralEventId = res.lastInsertRowid;
        }
        return;
      }
      if (transition.kind === 'started') {
        const a = transition.active;
        const res = this.insertNeutralEventStmt.run(
          a.startedTs, a.maxSpreadVolts, a.highLeg, a.peakHighVolts, a.peakLowVolts, a.nominalVolts,
        );
        this.activeNeutralEventId = res.lastInsertRowid;
        this.ctx.log(
          `neutral: divergence started — leg ${a.highLeg + 1} up to ${a.peakHighVolts.toFixed(1)} V, other down to ${a.peakLowVolts.toFixed(1)} V`,
        );
      } else if (transition.kind === 'ended' && this.activeNeutralEventId !== null) {
        const e = transition.episode;
        this.endNeutralEventStmt.run(
          e.endedTs, e.maxSpreadVolts, e.highLeg, e.peakHighVolts, e.peakLowVolts, e.nominalVolts,
          this.activeNeutralEventId,
        );
        this.activeNeutralEventId = null;
        this.ctx.log(
          `neutral: divergence ended — ${e.endedTs - e.startedTs}s, max spread ${e.maxSpreadVolts.toFixed(1)} V`,
        );
      } else if (transition.kind === 'discarded' && this.activeNeutralEventId !== null) {
        this.deleteNeutralEventStmt.run(this.activeNeutralEventId);
        this.activeNeutralEventId = null;
      }
    } catch (err) {
      this.ctx.log(`neutral tracking failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private trackVoltage(ts: number, legs: number[]): void {
    try {
      const transition = this.brownouts.sample(ts, legs);
      if (!transition) {
        // A sag that began in the same sample that closed a gapped-out event
        // surfaces via .active without a 'started' transition — persist it.
        const a = this.brownouts.active;
        if (a && this.activeVoltageEventId === null) {
          const res = this.insertVoltageEventStmt.run(a.startedTs, a.leg, a.minVolts, a.nominalVolts);
          this.activeVoltageEventId = res.lastInsertRowid;
        }
        return;
      }
      if (transition.kind === 'started') {
        const a = transition.active;
        const res = this.insertVoltageEventStmt.run(a.startedTs, a.leg, a.minVolts, a.nominalVolts);
        this.activeVoltageEventId = res.lastInsertRowid;
        this.ctx.log(
          `brownout: started — leg ${a.leg + 1} at ${a.minVolts.toFixed(1)} V (nominal ${a.nominalVolts.toFixed(1)} V)`,
        );
      } else if (transition.kind === 'ended' && this.activeVoltageEventId !== null) {
        const e = transition.event;
        this.endVoltageEventStmt.run(e.endedTs, e.leg, e.minVolts, e.nominalVolts, this.activeVoltageEventId);
        this.activeVoltageEventId = null;
        this.ctx.log(
          `brownout: ended — ${e.endedTs - e.startedTs}s, min ${e.minVolts.toFixed(1)} V on leg ${e.leg + 1}`,
        );
      } else if (transition.kind === 'discarded' && this.activeVoltageEventId !== null) {
        this.deleteVoltageEventStmt.run(this.activeVoltageEventId);
        this.activeVoltageEventId = null;
      }
    } catch (err) {
      this.ctx.log(`brownout tracking failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
