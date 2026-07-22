import { emitEvent, getDetectionSettings, type AppContext } from '../context.js';
import type { LiveDevice, LiveFrame, NilmLiveState } from '@sense/shared';
import type { SenseRealtimePayload } from '../sense/types.js';
import type { NilmEngine } from '../nilm/engine.js';
import { aggregateFrames, aggregateLegVoltages, bucketStart } from './rollup.js';
import { BrownoutDetector, type ActiveBrownout } from './brownout.js';
import { FloatingNeutralDetector, type ActiveNeutralEpisode } from './neutral.js';
import { MotorStallDetector, type ActiveStall } from './stall.js';

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
  private readonly insertVoltageRollupStmt;

  get activeBrownout(): ActiveBrownout | null {
    return this.brownouts.active;
  }

  get activeNeutralEpisode(): ActiveNeutralEpisode | null {
    return this.neutral.active;
  }

  private readonly stalls: MotorStallDetector;
  private activeStallEventId: number | bigint | null = null;
  private readonly insertStallEventStmt;
  private readonly updateStallEventStmt;

  get activeStall(): ActiveStall | null {
    return this.stalls.active;
  }

  applyDetectionSettings(): void {
    this.stalls.setMaxDutyCycle(getDetectionSettings(this.ctx).stallMaxDutyCycle);
    this.nilm.applySettings();
  }

  constructor(
    private readonly ctx: AppContext,
    private readonly nilm: NilmEngine,
  ) {
    this.stalls = new MotorStallDetector({
      maxDutyCycle: getDetectionSettings(ctx).stallMaxDutyCycle,
    });
    this.insertDeviceStmt = ctx.db.prepare(
      `INSERT OR IGNORE INTO devices (id, name, icon, type, tags_json, is_guess, revoked, first_seen, last_seen)
       VALUES (?, ?, ?, NULL, '{}', 0, 0, ?, ?)`,
    );
    this.touchLastSeenStmt = ctx.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?');
    this.insertPowerRollupStmt = ctx.db.prepare(
      `INSERT OR REPLACE INTO power_rollup (resolution, bucket, w_avg, w_min, w_max, volts, hz, sample_count, solar_w_avg)
       VALUES (30, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    this.insertVoltageRollupStmt = ctx.db.prepare(
      `INSERT OR REPLACE INTO voltage_rollup (resolution, bucket, leg, v_avg, v_min, v_max, sample_count)
       VALUES (30, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertStallEventStmt = ctx.db.prepare(
      `INSERT INTO stall_events (started_ts, ended_ts, spike_count, avg_spike_w, max_spike_w)
       VALUES (?, NULL, ?, ?, ?)`,
    );
    this.updateStallEventStmt = ctx.db.prepare(
      'UPDATE stall_events SET ended_ts = ?, spike_count = ?, avg_spike_w = ?, max_spike_w = ? WHERE id = ?',
    );
    // A crash mid-event leaves a dangling open row; close it with unknown
    // duration rather than letting it read as "active" forever.
    ctx.db.prepare('UPDATE voltage_events SET ended_ts = started_ts WHERE ended_ts IS NULL').run();
    ctx.db.prepare('UPDATE neutral_events SET ended_ts = started_ts WHERE ended_ts IS NULL').run();
    ctx.db.prepare('UPDATE stall_events SET ended_ts = started_ts WHERE ended_ts IS NULL').run();
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
    // NILM runs before the frame is built so its state rides the frame into
    // the ring buffer (and from there to the WS relay, MQTT, and metrics).
    let nilm: NilmLiveState | undefined;
    try {
      nilm = this.nilm.onFrame(ts, payload.w);
    } catch (err) {
      this.ctx.log(`nilm tracking failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const frame: LiveFrame = {
      ts,
      w: payload.w,
      solarW: payload.solar_w ?? null,
      volts,
      voltageLegs: payload.voltage ?? [],
      hz: payload.hz ?? null,
      devices,
      nilm,
    };
    if (payload.solar_w !== undefined && this.ctx.kv.get('solar.detected') === null) {
      this.ctx.kv.set('solar.detected', '1');
      this.ctx.log('solar: production data detected on this monitor');
    }
    this.ctx.ring.push(frame);
    this.ensureDevices(devices, ts);
    this.detectTransitions(devices, ts);
    this.trackVoltage(ts, payload.voltage ?? []);
    this.trackNeutral(ts, payload.voltage ?? []);
    this.trackStalls(ts, payload.w);
  };

  private trackStalls(ts: number, w: number): void {
    try {
      const transition = this.stalls.sample(ts, w);
      if (!transition) return;
      if (transition.kind === 'detected') {
        const a = transition.active;
        const res = this.insertStallEventStmt.run(a.startedTs, a.spikeCount, a.avgSpikeW, a.maxSpikeW);
        this.activeStallEventId = res.lastInsertRowid;
        this.ctx.log(
          `stall: repeated motor start attempts detected — ${a.spikeCount} spikes of ~${a.avgSpikeW.toFixed(0)} W`,
        );
        emitEvent(this.ctx, {
          type: 'stall.detected',
          ts: a.startedTs,
          spikeCount: a.spikeCount,
          avgSpikeW: a.avgSpikeW,
        });
      } else if (transition.kind === 'spike' && this.activeStallEventId !== null) {
        const a = transition.active;
        this.updateStallEventStmt.run(null, a.spikeCount, a.avgSpikeW, a.maxSpikeW, this.activeStallEventId);
      } else if (transition.kind === 'ended' && this.activeStallEventId !== null) {
        const e = transition.event;
        this.updateStallEventStmt.run(e.endedTs, e.spikeCount, e.avgSpikeW, e.maxSpikeW, this.activeStallEventId);
        this.activeStallEventId = null;
        this.ctx.log(
          `stall: cluster ended — ${e.spikeCount} spikes, avg ${e.avgSpikeW.toFixed(0)} W, max ${e.maxSpikeW.toFixed(0)} W`,
        );
        emitEvent(this.ctx, {
          type: 'stall.ended',
          ts: e.endedTs,
          spikeCount: e.spikeCount,
          avgSpikeW: e.avgSpikeW,
          maxSpikeW: e.maxSpikeW,
        });
      } else if (transition.kind === 'invalidated' && this.activeStallEventId !== null) {
        this.ctx.db.prepare('DELETE FROM stall_events WHERE id = ?').run(this.activeStallEventId);
        this.activeStallEventId = null;
        this.ctx.log('stall: cluster invalidated — duty cycle reveals appliance cycling, event removed');
      }
    } catch (err) {
      this.ctx.log(`stall tracking failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
        emitEvent(this.ctx, {
          type: 'neutral.started',
          ts: a.startedTs,
          maxSpreadVolts: a.maxSpreadVolts,
        });
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
        emitEvent(this.ctx, {
          type: 'neutral.ended',
          ts: e.endedTs,
          maxSpreadVolts: e.maxSpreadVolts,
          durationS: e.endedTs - e.startedTs,
        });
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
        emitEvent(this.ctx, {
          type: 'brownout.started',
          ts: a.startedTs,
          leg: a.leg,
          minVolts: a.minVolts,
          nominalVolts: a.nominalVolts,
        });
      } else if (transition.kind === 'ended' && this.activeVoltageEventId !== null) {
        const e = transition.event;
        this.endVoltageEventStmt.run(e.endedTs, e.leg, e.minVolts, e.nominalVolts, this.activeVoltageEventId);
        this.activeVoltageEventId = null;
        this.ctx.log(
          `brownout: ended — ${e.endedTs - e.startedTs}s, min ${e.minVolts.toFixed(1)} V on leg ${e.leg + 1}`,
        );
        emitEvent(this.ctx, {
          type: 'brownout.ended',
          ts: e.endedTs,
          leg: e.leg,
          minVolts: e.minVolts,
          durationS: e.endedTs - e.startedTs,
        });
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

  private readonly onSince = new Map<string, number>();
  private readonly lastNames = new Map<string, string>();

  private detectTransitions(devices: LiveDevice[], ts: number): void {
    const seenNow = new Map(devices.map((d) => [d.id, d] as const));
    for (const [id, d] of seenNow) this.lastNames.set(id, d.name);
    for (const [id, d] of seenNow) {
      const wasOn = (this.prevDevices.get(id) ?? 0) > ON_THRESHOLD_W;
      if (!wasOn && d.w > ON_THRESHOLD_W) {
        this.recordEvent(id, ts, 'on', d.w);
        this.onSince.set(id, ts);
        emitEvent(this.ctx, { type: 'device.on', ts, deviceId: id, name: d.name, w: d.w });
      }
    }
    for (const [id, prevW] of this.prevDevices) {
      const wasOn = prevW > ON_THRESHOLD_W;
      const isOn = (seenNow.get(id)?.w ?? 0) > ON_THRESHOLD_W;
      if (wasOn && !isOn) {
        this.recordEvent(id, ts, 'off', seenNow.get(id)?.w ?? null);
        const since = this.onSince.get(id);
        this.onSince.delete(id);
        emitEvent(this.ctx, {
          type: 'device.off',
          ts,
          deviceId: id,
          name: this.lastNames.get(id) ?? id,
          runtimeS: since !== undefined ? ts - since : null,
        });
      }
    }
    const next = new Map<string, number>();
    for (const [id, d] of seenNow) next.set(id, d.w);
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
      const legAggs = aggregateLegVoltages(frames);
      this.ctx.db.transaction(() => {
        this.insertPowerRollupStmt.run(bStart, agg.wAvg, agg.wMin, agg.wMax, agg.volts, agg.hz, agg.sampleCount, agg.solarWAvg);
        for (const [deviceId, { wAvg }] of agg.perDevice) {
          if (wAvg <= DEVICE_ROLLUP_MIN_W) continue;
          if (!this.deviceExistsStmt.get(deviceId)) continue;
          this.insertDevicePowerRollupStmt.run(bStart, deviceId, wAvg, agg.sampleCount);
        }
        for (const [leg, v] of legAggs) {
          this.insertVoltageRollupStmt.run(bStart, leg, v.vAvg, v.vMin, v.vMax, v.sampleCount);
        }
      })();
    } catch (err) {
      this.ctx.log(`realtime flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
