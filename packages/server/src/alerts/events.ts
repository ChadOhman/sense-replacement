/** Typed in-process application events. Emitted on ctx.events; consumed by
 *  the notifier and the MQTT publisher. */

export type AppEvent =
  | { type: 'brownout.started'; ts: number; leg: number; minVolts: number; nominalVolts: number }
  | { type: 'brownout.ended'; ts: number; leg: number; minVolts: number; durationS: number }
  | { type: 'neutral.started'; ts: number; maxSpreadVolts: number }
  | { type: 'neutral.ended'; ts: number; maxSpreadVolts: number; durationS: number }
  | { type: 'stall.detected'; ts: number; spikeCount: number; avgSpikeW: number }
  | { type: 'stall.ended'; ts: number; spikeCount: number; avgSpikeW: number; maxSpikeW: number }
  | { type: 'device.on'; ts: number; deviceId: string; name: string; w: number }
  | { type: 'device.off'; ts: number; deviceId: string; name: string; runtimeS: number | null }
  | { type: 'alwayson.creep'; ts: number; currentW: number; baselineW: number }
  | { type: 'anomaly.device'; ts: number; deviceId: string; name: string; pct: number; direction: 'up' | 'down' }
  // Local NILM detections. deviceId is a local integer (nilm_devices.id),
  // not a cloud device id. `reason` distinguishes a matched off-transient
  // from an off_delay timer or a negative-residual force-off.
  | { type: 'nilm.device.on'; ts: number; deviceId: number; name: string; w: number }
  | {
      type: 'nilm.device.off';
      ts: number;
      deviceId: number;
      name: string;
      runtimeS: number;
      reason: 'matched' | 'off_delay' | 'force_off';
    };

export const EVENT_NAME = 'app-event';
