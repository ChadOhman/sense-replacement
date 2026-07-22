/**
 * Pure alert decision logic: mapping app events to user-facing alert
 * categories, formatting notification content, and gating whether a given
 * event should actually be sent (enabled kinds, debounce, quiet hours,
 * device-finished thresholds). No I/O, no wall-clock reads — all timing
 * comes in via arguments, so this is fully deterministic and unit-testable
 * in isolation from the realtime pipeline.
 */

import type { AlertKind, AlertSettings } from '@sense/shared';
import type { AppEvent } from './events.js';

/** Debounce window: the same alert kind won't re-send more often than this. */
const DEBOUNCE_S = 300;

/**
 * Map an event to its user-facing toggle category. Returns null for events
 * we never notify on: `device.on` (only the finished edge is actionable).
 * `brownout.ended` / `stall.ended` / `neutral.ended` map to the same kind
 * as their "started"/"detected" counterpart — they're recovery notices,
 * gated by the same toggle and debounce bucket.
 */
export function kindOf(event: AppEvent): AlertKind | null {
  switch (event.type) {
    case 'brownout.started':
    case 'brownout.ended':
      return 'brownout';
    case 'neutral.started':
    case 'neutral.ended':
      return 'neutral';
    case 'stall.detected':
    case 'stall.ended':
      return 'stall';
    case 'device.on':
      return null;
    case 'device.off':
      return 'device_finished';
    case 'alwayson.creep':
      return 'alwayson_creep';
    case 'anomaly.device':
      return 'device_anomaly';
    // NILM on/off edges drive MQTT state, not notifications.
    case 'nilm.device.on':
    case 'nilm.device.off':
      return null;
  }
}

export interface FormattedEvent {
  title: string;
  body: string;
  priority: 'default' | 'high';
  tags: string[];
}

function fmtV(v: number): string {
  return v.toFixed(1);
}

function fmtW(w: number): string {
  return w.toFixed(0);
}

function fmtMinutes(runtimeS: number): string {
  const min = Math.round(runtimeS / 60);
  return `${min} min`;
}

/** Human-readable notification content for an app event. */
export function formatEvent(event: AppEvent): FormattedEvent {
  switch (event.type) {
    case 'brownout.started':
      return {
        title: 'Brownout started',
        body: `Leg ${event.leg + 1} down to ${fmtV(event.minVolts)} V (nominal ${event.nominalVolts} V)`,
        priority: 'high',
        tags: ['warning', 'zap'],
      };
    case 'brownout.ended':
      return {
        title: 'Brownout ended',
        body: `Leg ${event.leg + 1} recovered after ${event.durationS}s (min ${fmtV(event.minVolts)} V)`,
        priority: 'default',
        tags: ['white_check_mark', 'zap'],
      };
    case 'neutral.started':
      return {
        title: 'Neutral divergence started',
        body: `Legs diverged by ${fmtV(event.maxSpreadVolts)} V`,
        priority: 'high',
        tags: ['warning', 'large_orange_diamond'],
      };
    case 'neutral.ended':
      return {
        title: 'Neutral divergence ended',
        body: `Recovered after ${event.durationS}s (max spread ${fmtV(event.maxSpreadVolts)} V)`,
        priority: 'default',
        tags: ['white_check_mark', 'large_orange_diamond'],
      };
    case 'stall.detected':
      return {
        title: 'Motor stall detected',
        body: `${event.spikeCount} spikes averaging ${fmtW(event.avgSpikeW)} W`,
        priority: 'high',
        tags: ['warning', 'repeat'],
      };
    case 'stall.ended':
      return {
        title: 'Motor stall ended',
        body: `Cluster of ${event.spikeCount} spikes ended (avg ${fmtW(event.avgSpikeW)} W, max ${fmtW(event.maxSpikeW)} W)`,
        priority: 'default',
        tags: ['white_check_mark', 'repeat'],
      };
    case 'device.on':
      return {
        title: `${event.name} started`,
        body: `Drawing ${fmtW(event.w)} W`,
        priority: 'default',
        tags: ['electric_plug'],
      };
    case 'device.off':
      return {
        title: `${event.name} finished`,
        body: event.runtimeS === null ? 'Finished (duration unknown)' : `Ran for ${fmtMinutes(event.runtimeS)}`,
        priority: 'default',
        tags: ['stopwatch'],
      };
    case 'alwayson.creep':
      return {
        title: 'Always-on baseline creeping up',
        body: `Now ${fmtW(event.currentW)} W baseline (was ${fmtW(event.baselineW)} W)`,
        priority: 'default',
        tags: ['chart_with_upwards_trend'],
      };
    case 'anomaly.device':
      return {
        title: `${event.name} anomaly`,
        body: `${event.direction === 'up' ? 'Up' : 'Down'} ${event.pct.toFixed(0)}% vs usual`,
        priority: 'default',
        tags: [event.direction === 'up' ? 'arrow_up' : 'arrow_down'],
      };
    // Unreachable in practice (kindOf gates these to null) but the switch
    // stays exhaustive.
    case 'nilm.device.on':
      return {
        title: `${event.name} started`,
        body: `Drawing ~${fmtW(event.w)} W`,
        priority: 'default',
        tags: ['electric_plug'],
      };
    case 'nilm.device.off':
      return {
        title: `${event.name} finished`,
        body: `Ran for ${fmtMinutes(event.runtimeS)}`,
        priority: 'default',
        tags: ['stopwatch'],
      };
  }
}

/** Whether `localHour` falls inside the quiet-hours window, with
 *  wraparound support (e.g. startHour 22, endHour 7 covers 22..23, 0..6).
 *  startHour === endHour (or a null window) means never quiet. */
function isQuietHour(localHour: number, quietHours: AlertSettings['quietHours']): boolean {
  if (quietHours === null) return false;
  const { startHour, endHour } = quietHours;
  if (startHour === endHour) return false;
  if (startHour < endHour) {
    return localHour >= startHour && localHour < endHour;
  }
  // Wraparound window, e.g. 22 -> 7.
  return localHour >= startHour || localHour < endHour;
}

/**
 * Full send gate: is the event's kind enabled, outside the debounce window,
 * not suppressed by quiet hours, and (for device_finished) does it meet the
 * configured device/runtime thresholds.
 *
 * Pure: this does NOT record the send — the caller is responsible for
 * persisting `nowTs` as the new lastSentTs for the kind once it actually
 * sends.
 */
export function shouldSend(
  event: AppEvent,
  settings: AlertSettings,
  localHour: number,
  lastSentTsForKind: number | null,
  nowTs: number,
): boolean {
  const kind = kindOf(event);
  if (kind === null) return false;
  if (!settings.enabled[kind]) return false;

  if (lastSentTsForKind !== null && nowTs - lastSentTsForKind < DEBOUNCE_S) {
    return false;
  }

  const { priority } = formatEvent(event);
  if (priority !== 'high' && isQuietHour(localHour, settings.quietHours)) {
    return false;
  }

  if (event.type === 'device.off') {
    if (!settings.finishedDeviceIds.includes(event.deviceId)) return false;
    if (event.runtimeS === null) return false;
    if (event.runtimeS < settings.finishedMinRuntimeS) return false;
  }

  return true;
}

/** Tracks device run times so `device.off` events can carry runtimeS. */
export class DeviceRuntimeTracker {
  private readonly onTimes = new Map<string, number>();

  markOn(deviceId: string, ts: number): void {
    this.onTimes.set(deviceId, ts);
  }

  /** Returns runtime seconds if we saw the ON edge, else null. Clears state. */
  markOff(deviceId: string, ts: number): number | null {
    const onTs = this.onTimes.get(deviceId);
    if (onTs === undefined) return null;
    this.onTimes.delete(deviceId);
    return ts - onTs;
  }
}
