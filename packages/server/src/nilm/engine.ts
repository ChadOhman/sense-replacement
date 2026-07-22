/**
 * Stateful NILM engine: owns the DB statements and glues the pure modules
 * (capture, match, baseline, unknown) into the realtime pipeline. Fed one
 * sample per frame by RealtimeCollector; its returned live state is embedded
 * into the frame before it enters the ring buffer, so the WS relay, MQTT
 * publisher, and Prometheus all see NILM data for free.
 */

import type { NilmLiveState } from '@sense/shared';
import { emitEvent, getDetectionSettings, type AppContext } from '../context.js';
import { EventCaptureDetector, type CapturedEvent } from './capture.js';
import { clusterPass, type ClusterRow, type EventRow } from './cluster.js';
import { matchEvent, type MatchProfile } from './match.js';
import { RollingMinBaseline } from './baseline.js';
import { computeUnknown, findForceOff, type OnDeviceEst } from './unknown.js';

/** Residual below −this (watts) counts toward the force-off streak. */
const NEGATIVE_RESIDUAL_W = 50;
/** Consecutive negative samples before the self-correction force-off fires. */
const NEGATIVE_STREAK_SAMPLES = 30;

/** Cap on unclustered events fed to one clustering pass. */
const CLUSTER_PASS_LIMIT = 5000;

const LAST_CLUSTER_RUN_KEY = 'nilm.lastClusterRun';

interface DeviceMeta {
  name: string;
  estW: number | null;
  offDelayS: number | null;
}

interface OnState {
  sinceTs: number;
  estW: number;
  /** ts at which to auto-emit OFF; null when relying on a matched off-event. */
  offAtTs: number | null;
}

export class NilmEngine {
  private readonly capture: EventCaptureDetector;
  private readonly baseline = new RollingMinBaseline();

  private profiles: MatchProfile[] = [];
  private deviceMeta = new Map<number, DeviceMeta>();
  private readonly onState = new Map<number, OnState>();
  private negativeStreak = 0;
  private lastState: NilmLiveState | null = null;

  private readonly insertEventStmt;
  private readonly insertClusterStmt;
  private readonly assignEventStmt;
  private readonly updateClusterSizeStmt;

  constructor(private readonly ctx: AppContext) {
    this.capture = new EventCaptureDetector({ triggerW: getDetectionSettings(ctx).nilmTriggerW });
    this.insertEventStmt = ctx.db.prepare(
      `INSERT INTO nilm_events (ts, direction, delta_w, waveform_json, cluster_id, matched_live)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.insertClusterStmt = ctx.db.prepare(
      `INSERT INTO nilm_clusters (direction, profile_json, radius, size, device_id, updated_ts)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    );
    this.assignEventStmt = ctx.db.prepare('UPDATE nilm_events SET cluster_id = ? WHERE id = ?');
    this.updateClusterSizeStmt = ctx.db.prepare(
      'UPDATE nilm_clusters SET size = ?, updated_ts = ? WHERE id = ?',
    );
    this.reloadProfiles();
  }

  /** Latest computed state; null before the first frame. */
  get liveState(): NilmLiveState | null {
    return this.lastState;
  }

  /** Re-read labeled cluster profiles and device tuning from the DB. Called
   *  after any labeling write and after each clustering pass — this is how
   *  new labels reach the live matcher without a restart. */
  reloadProfiles(): void {
    const clusterRows = this.ctx.db
      .prepare(
        `SELECT c.id, c.direction, c.profile_json, c.radius, c.device_id, d.max_match_distance
         FROM nilm_clusters c JOIN nilm_devices d ON d.id = c.device_id`,
      )
      .all() as {
      id: number;
      direction: 'on' | 'off';
      profile_json: string;
      radius: number;
      device_id: number;
      max_match_distance: number | null;
    }[];
    this.profiles = clusterRows.map((r) => ({
      clusterId: r.id,
      deviceId: r.device_id,
      direction: r.direction,
      profile: JSON.parse(r.profile_json) as number[],
      radius: r.radius,
      maxMatchDistance: r.max_match_distance,
    }));

    const deviceRows = this.ctx.db
      .prepare('SELECT id, name, est_w, off_delay_s FROM nilm_devices')
      .all() as { id: number; name: string; est_w: number | null; off_delay_s: number | null }[];
    this.deviceMeta = new Map(
      deviceRows.map((r) => [r.id, { name: r.name, estW: r.est_w, offDelayS: r.off_delay_s }]),
    );
    // A deleted device must not linger as ON.
    for (const id of this.onState.keys()) {
      if (!this.deviceMeta.has(id)) this.onState.delete(id);
    }
  }

  /** Push current detection settings into the capture detector. */
  applySettings(): void {
    this.capture.setTriggerW(getDetectionSettings(this.ctx).nilmTriggerW);
  }

  /** Feed one whole-home power sample; returns the state to embed in the frame. */
  onFrame(ts: number, w: number): NilmLiveState {
    const captured = this.capture.sample(ts, w);
    if (captured) this.handleEvent(ts, captured);

    this.expireOffDelays(ts);
    this.baseline.sample(ts, w);

    const baselineW = this.baseline.value();
    const onDevices = this.onDeviceEstimates();
    let unknownW: number | null = null;
    if (baselineW !== null) {
      unknownW = computeUnknown(w, baselineW, onDevices);
      this.selfCorrect(ts, unknownW, onDevices);
    }

    this.lastState = {
      baselineW,
      unknownW,
      devices: [...this.onState.entries()].map(([id, s]) => ({
        id,
        name: this.deviceMeta.get(id)?.name ?? `device ${id}`,
        estW: s.estW,
        sinceTs: s.sinceTs,
      })),
    };
    return this.lastState;
  }

  private handleEvent(ts: number, event: CapturedEvent): void {
    const match = matchEvent(event.waveform, event.direction, this.profiles);
    this.insertEventStmt.run(
      event.startTs,
      event.direction,
      event.deltaW,
      JSON.stringify(event.waveform),
      match?.clusterId ?? null,
      match ? 1 : 0,
    );
    if (!match) return;

    const meta = this.deviceMeta.get(match.deviceId);
    if (!meta) return;

    if (event.direction === 'on') {
      const estW = meta.estW ?? Math.abs(event.deltaW);
      const already = this.onState.get(match.deviceId);
      this.onState.set(match.deviceId, {
        sinceTs: already?.sinceTs ?? event.startTs,
        estW,
        offAtTs: meta.offDelayS !== null ? ts + meta.offDelayS : null,
      });
      if (!already) {
        emitEvent(this.ctx, {
          type: 'nilm.device.on',
          ts: event.startTs,
          deviceId: match.deviceId,
          name: meta.name,
          w: estW,
        });
      }
    } else {
      this.turnOff(match.deviceId, ts, 'matched');
    }
  }

  private expireOffDelays(ts: number): void {
    for (const [id, state] of this.onState) {
      if (state.offAtTs !== null && ts >= state.offAtTs) this.turnOff(id, ts, 'off_delay');
    }
  }

  private selfCorrect(ts: number, unknownW: number, onDevices: OnDeviceEst[]): void {
    if (unknownW < -NEGATIVE_RESIDUAL_W && onDevices.length > 0) {
      this.negativeStreak++;
      if (this.negativeStreak >= NEGATIVE_STREAK_SAMPLES) {
        const victim = findForceOff(unknownW, onDevices);
        if (victim !== null) this.turnOff(victim, ts, 'force_off');
        this.negativeStreak = 0;
      }
    } else {
      this.negativeStreak = 0;
    }
  }

  private turnOff(deviceId: number, ts: number, reason: 'matched' | 'off_delay' | 'force_off'): void {
    const state = this.onState.get(deviceId);
    if (!state) return;
    this.onState.delete(deviceId);
    emitEvent(this.ctx, {
      type: 'nilm.device.off',
      ts,
      deviceId,
      name: this.deviceMeta.get(deviceId)?.name ?? `device ${deviceId}`,
      runtimeS: ts - state.sinceTs,
      reason,
    });
  }

  private onDeviceEstimates(): OnDeviceEst[] {
    return [...this.onState.entries()].map(([id, s]) => ({ id, estW: s.estW }));
  }

  /** Cluster the backlog of unassigned events. Runs hourly and on demand
   *  from the labeling UI. */
  runClusteringPass(): { assigned: number; newClusters: number } {
    const splitDistance = getDetectionSettings(this.ctx).nilmClusterSplitDistance;

    const existing = (
      this.ctx.db
        .prepare('SELECT id, direction, profile_json, radius, size FROM nilm_clusters')
        .all() as { id: number; direction: 'on' | 'off'; profile_json: string; radius: number; size: number }[]
    ).map(
      (r): ClusterRow => ({
        id: r.id,
        direction: r.direction,
        profile: JSON.parse(r.profile_json) as number[],
        radius: r.radius,
        size: r.size,
      }),
    );

    const events = (
      this.ctx.db
        .prepare(
          `SELECT id, direction, waveform_json FROM nilm_events
           WHERE cluster_id IS NULL ORDER BY ts DESC LIMIT ${CLUSTER_PASS_LIMIT}`,
        )
        .all() as { id: number; direction: 'on' | 'off'; waveform_json: string }[]
    ).map(
      (r): EventRow => ({
        id: r.id,
        direction: r.direction,
        waveform: JSON.parse(r.waveform_json) as number[],
      }),
    );

    const result = clusterPass(existing, events, splitDistance);
    const now = Math.floor(Date.now() / 1000);

    this.ctx.db.transaction(() => {
      for (const a of result.assignments) this.assignEventStmt.run(a.clusterId, a.eventId);
      for (const u of result.updatedSizes) this.updateClusterSizeStmt.run(u.size, now, u.clusterId);
      for (const c of result.newClusters) {
        const res = this.insertClusterStmt.run(
          c.direction,
          JSON.stringify(c.profile),
          c.radius,
          c.size,
          now,
        );
        for (const eventId of c.eventIds) this.assignEventStmt.run(res.lastInsertRowid, eventId);
      }
      this.ctx.kv.set(LAST_CLUSTER_RUN_KEY, String(now));
    })();

    this.reloadProfiles();
    return { assigned: result.assignments.length, newClusters: result.newClusters.length };
  }
}
