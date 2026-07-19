/**
 * Pure MQTT / Home Assistant payload builders. No mqtt import, no I/O — this
 * module only knows how to turn domain data into `{ topic, payload }`
 * messages; the actual publish loop lives elsewhere.
 */

import type { LiveFrame } from '@sense/shared';

export interface MqttMessage {
  topic: string;
  payload: string;
  retain?: boolean;
}

const BASE_TOPIC = 'sense';
const STATUS_TOPIC = 'sense/status';
const DISCOVERY_PREFIX = 'homeassistant';

const HA_DEVICE = {
  identifiers: ['sense-replacement'],
  name: 'Sense Monitor',
  manufacturer: 'sense-replacement',
};

/** Sanitize a device id into an MQTT/HA-safe object id: lowercase,
 *  [a-z0-9_], with any run of other characters collapsed to a single `_`
 *  (and stripped from the ends). e.g. 'AC Unit #2' -> 'ac_unit_2'. */
export function objectId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function discoveryTopic(component: 'sensor' | 'binary_sensor', objId: string): string {
  return `${DISCOVERY_PREFIX}/${component}/sense_${objId}/config`;
}

interface SensorOpts {
  name: string;
  uniqueId: string;
  stateTopic: string;
  unitOfMeasurement: string;
  deviceClass?: string;
  stateClass?: string;
}

function sensorPayload(opts: SensorOpts): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: opts.name,
    unique_id: opts.uniqueId,
    state_topic: opts.stateTopic,
    unit_of_measurement: opts.unitOfMeasurement,
    availability_topic: STATUS_TOPIC,
    device: HA_DEVICE,
  };
  if (opts.deviceClass) payload.device_class = opts.deviceClass;
  if (opts.stateClass) payload.state_class = opts.stateClass;
  return payload;
}

interface BinarySensorOpts {
  name: string;
  uniqueId: string;
  stateTopic: string;
  deviceClass?: string;
}

function binarySensorPayload(opts: BinarySensorOpts): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: opts.name,
    unique_id: opts.uniqueId,
    state_topic: opts.stateTopic,
    payload_on: 'ON',
    payload_off: 'OFF',
    availability_topic: STATUS_TOPIC,
    device: HA_DEVICE,
  };
  if (opts.deviceClass) payload.device_class = opts.deviceClass;
  return payload;
}

function discoveryMsg(
  component: 'sensor' | 'binary_sensor',
  objId: string,
  payload: Record<string, unknown>,
): MqttMessage {
  return { topic: discoveryTopic(component, objId), payload: JSON.stringify(payload), retain: true };
}

/**
 * HA discovery configs (retain: true) advertising the fixed set of
 * whole-home sensors/binary sensors plus one sensor + one binary sensor per
 * detected device.
 */
export function discoveryMessages(devices: { id: string; name: string }[]): MqttMessage[] {
  const messages: MqttMessage[] = [];

  messages.push(
    discoveryMsg(
      'sensor',
      'power',
      sensorPayload({
        name: 'Total Power',
        uniqueId: 'sense_power',
        stateTopic: `${BASE_TOPIC}/power`,
        unitOfMeasurement: 'W',
        deviceClass: 'power',
        stateClass: 'measurement',
      }),
    ),
  );

  for (let leg = 0; leg < 2; leg++) {
    messages.push(
      discoveryMsg(
        'sensor',
        `voltage_${leg}`,
        sensorPayload({
          name: `Leg ${leg + 1} Voltage`,
          uniqueId: `sense_voltage_${leg}`,
          stateTopic: `${BASE_TOPIC}/voltage/${leg}`,
          unitOfMeasurement: 'V',
          deviceClass: 'voltage',
        }),
      ),
    );
  }

  messages.push(
    discoveryMsg(
      'sensor',
      'frequency',
      sensorPayload({
        name: 'Frequency',
        uniqueId: 'sense_frequency',
        stateTopic: `${BASE_TOPIC}/frequency`,
        unitOfMeasurement: 'Hz',
      }),
    ),
  );

  messages.push(
    discoveryMsg(
      'sensor',
      'energy_today',
      sensorPayload({
        name: 'Energy Today',
        uniqueId: 'sense_energy_today',
        stateTopic: `${BASE_TOPIC}/energy_today`,
        unitOfMeasurement: 'kWh',
        deviceClass: 'energy',
        stateClass: 'total_increasing',
      }),
    ),
  );

  const alerts: { key: 'brownout' | 'neutral' | 'stall'; name: string }[] = [
    { key: 'brownout', name: 'Brownout' },
    { key: 'neutral', name: 'Neutral Divergence' },
    { key: 'stall', name: 'Motor Stall' },
  ];
  for (const alert of alerts) {
    messages.push(
      discoveryMsg(
        'binary_sensor',
        alert.key,
        binarySensorPayload({
          name: alert.name,
          uniqueId: `sense_${alert.key}`,
          stateTopic: `${BASE_TOPIC}/alert/${alert.key}`,
          deviceClass: 'problem',
        }),
      ),
    );
  }

  for (const device of devices) {
    const objId = objectId(device.id);
    messages.push(
      discoveryMsg(
        'sensor',
        `device_${objId}_power`,
        sensorPayload({
          name: `${device.name} Power`,
          uniqueId: `sense_device_${objId}_power`,
          stateTopic: `${BASE_TOPIC}/device/${device.id}/power`,
          unitOfMeasurement: 'W',
        }),
      ),
    );
    messages.push(
      discoveryMsg(
        'binary_sensor',
        `device_${objId}`,
        binarySensorPayload({
          name: device.name,
          uniqueId: `sense_device_${objId}`,
          stateTopic: `${BASE_TOPIC}/device/${device.id}/state`,
        }),
      ),
    );
  }

  return messages;
}

/**
 * Per-frame state messages (not retained): total power, per-leg voltage,
 * frequency, and per-device power/state. Devices present in `knownDeviceIds`
 * but absent from this frame only get an OFF/0 message if they're in
 * `changedToOff` — avoids re-publishing OFF for every absent device every
 * frame.
 */
export function frameMessages(frame: LiveFrame, changedToOff: string[]): MqttMessage[] {
  const messages: MqttMessage[] = [];

  messages.push({ topic: `${BASE_TOPIC}/power`, payload: frame.w.toFixed(1), retain: false });

  frame.voltageLegs.forEach((v, i) => {
    messages.push({ topic: `${BASE_TOPIC}/voltage/${i}`, payload: v.toFixed(1), retain: false });
  });

  if (frame.hz !== null) {
    messages.push({ topic: `${BASE_TOPIC}/frequency`, payload: frame.hz.toFixed(2), retain: false });
  }

  for (const device of frame.devices) {
    messages.push({
      topic: `${BASE_TOPIC}/device/${device.id}/power`,
      payload: device.w.toFixed(1),
      retain: false,
    });
    messages.push({ topic: `${BASE_TOPIC}/device/${device.id}/state`, payload: 'ON', retain: false });
  }

  for (const id of changedToOff) {
    messages.push({ topic: `${BASE_TOPIC}/device/${id}/power`, payload: '0', retain: false });
    messages.push({ topic: `${BASE_TOPIC}/device/${id}/state`, payload: 'OFF', retain: false });
  }

  return messages;
}

/** sense/energy_today message (retained), value in kWh, 2 decimals. */
export function energyMessage(kwhToday: number): MqttMessage {
  return { topic: `${BASE_TOPIC}/energy_today`, payload: kwhToday.toFixed(2), retain: true };
}

/** sense/alert/{brownout|neutral|stall} ON/OFF messages (retained). */
export function alertMessages(state: { brownout: boolean; neutral: boolean; stall: boolean }): MqttMessage[] {
  return [
    { topic: `${BASE_TOPIC}/alert/brownout`, payload: state.brownout ? 'ON' : 'OFF', retain: true },
    { topic: `${BASE_TOPIC}/alert/neutral`, payload: state.neutral ? 'ON' : 'OFF', retain: true },
    { topic: `${BASE_TOPIC}/alert/stall`, payload: state.stall ? 'ON' : 'OFF', retain: true },
  ];
}
