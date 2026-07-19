import type { LiveFrame } from '@sense/shared';
import { describe, expect, it } from 'vitest';
import { alertMessages, discoveryMessages, energyMessage, frameMessages, objectId } from './ha.js';

interface DiscoveryPayload {
  name: string;
  unique_id: string;
  state_topic: string;
  availability_topic: string;
  device: { identifiers: string[]; name: string; manufacturer: string };
  unit_of_measurement?: string;
  device_class?: string;
  state_class?: string;
  payload_on?: string;
  payload_off?: string;
}

function parse(payload: string): DiscoveryPayload {
  return JSON.parse(payload) as DiscoveryPayload;
}

describe('discoveryMessages', () => {
  it('produces valid JSON payloads with required HA keys, retained', () => {
    const messages = discoveryMessages([]);
    expect(messages.length).toBeGreaterThan(0);
    for (const msg of messages) {
      expect(msg.retain).toBe(true);
      const payload = parse(msg.payload);
      expect(payload.state_topic).toBeTruthy();
      expect(payload.unique_id).toBeTruthy();
      expect(payload.availability_topic).toBe('sense/status');
      expect(payload.device).toEqual({
        identifiers: ['sense-replacement'],
        name: 'Sense Monitor',
        manufacturer: 'sense-replacement',
      });
    }
  });

  it('produces correct counts: 5 base sensors + 3 alert binary sensors, and 2 more per device', () => {
    const noDevices = discoveryMessages([]);
    const sensorTopics = noDevices.filter((m) => m.topic.startsWith('homeassistant/sensor/'));
    const binarySensorTopics = noDevices.filter((m) => m.topic.startsWith('homeassistant/binary_sensor/'));
    // total power, voltage/0, voltage/1, frequency, energy_today
    expect(sensorTopics.length).toBe(5);
    // brownout, neutral, stall
    expect(binarySensorTopics.length).toBe(3);
    expect(noDevices.length).toBe(8);

    const withTwoDevices = discoveryMessages([
      { id: 'd1', name: 'Fridge' },
      { id: 'd2', name: 'Dryer' },
    ]);
    expect(withTwoDevices.length).toBe(8 + 2 * 2);
  });

  it('includes device_class/state_class on the total power and energy sensors', () => {
    const messages = discoveryMessages([]);
    const power = messages.find((m) => m.topic === 'homeassistant/sensor/sense_power/config')!;
    const powerPayload = parse(power.payload);
    expect(powerPayload.device_class).toBe('power');
    expect(powerPayload.state_class).toBe('measurement');
    expect(powerPayload.state_topic).toBe('sense/power');

    const energy = messages.find((m) => m.topic === 'homeassistant/sensor/sense_energy_today/config')!;
    const energyPayload = parse(energy.payload);
    expect(energyPayload.device_class).toBe('energy');
    expect(energyPayload.state_class).toBe('total_increasing');
  });

  it('marks alert binary sensors as device_class problem with ON/OFF payloads', () => {
    const messages = discoveryMessages([]);
    const brownout = messages.find((m) => m.topic === 'homeassistant/binary_sensor/sense_brownout/config')!;
    const payload = parse(brownout.payload);
    expect(payload.device_class).toBe('problem');
    expect(payload.payload_on).toBe('ON');
    expect(payload.payload_off).toBe('OFF');
    expect(payload.state_topic).toBe('sense/alert/brownout');
  });

  it('emits a per-device power sensor and state binary sensor using the sanitized object id', () => {
    const messages = discoveryMessages([{ id: 'AC Unit #2', name: 'AC Unit 2' }]);
    const objId = objectId('AC Unit #2');
    const power = messages.find((m) => m.topic === `homeassistant/sensor/sense_device_${objId}_power/config`);
    const state = messages.find((m) => m.topic === `homeassistant/binary_sensor/sense_device_${objId}/config`);
    expect(power).toBeDefined();
    expect(state).toBeDefined();
    const powerPayload = parse(power!.payload);
    expect(powerPayload.state_topic).toBe('sense/device/AC Unit #2/power');
    const statePayload = parse(state!.payload);
    expect(statePayload.state_topic).toBe('sense/device/AC Unit #2/state');
    expect(statePayload.device_class).toBeUndefined();
  });
});

describe('frameMessages', () => {
  const baseFrame: LiveFrame = {
    ts: 1000,
    w: 1234.5,
    volts: 120.5,
    voltageLegs: [120.1, 121.2],
    hz: 59.98,
    devices: [{ id: 'd1', name: 'Fridge', icon: null, w: 150.25 }],
  };

  it('emits power, per-leg voltage, and frequency, all unretained', () => {
    const messages = frameMessages(baseFrame, []);
    const power = messages.find((m) => m.topic === 'sense/power');
    expect(power).toEqual({ topic: 'sense/power', payload: '1234.5', retain: false });

    const v0 = messages.find((m) => m.topic === 'sense/voltage/0');
    const v1 = messages.find((m) => m.topic === 'sense/voltage/1');
    expect(v0?.payload).toBe('120.1');
    expect(v1?.payload).toBe('121.2');

    const freq = messages.find((m) => m.topic === 'sense/frequency');
    expect(freq?.payload).toBe('59.98');
    for (const m of messages) {
      expect(m.retain).toBe(false);
    }
  });

  it('omits frequency message when hz is null', () => {
    const messages = frameMessages({ ...baseFrame, hz: null }, []);
    expect(messages.find((m) => m.topic === 'sense/frequency')).toBeUndefined();
  });

  it('emits ON + power for devices present in the frame', () => {
    const messages = frameMessages(baseFrame, []);
    const state = messages.find((m) => m.topic === 'sense/device/d1/state');
    const power = messages.find((m) => m.topic === 'sense/device/d1/power');
    expect(state?.payload).toBe('ON');
    expect(power?.payload).toBe('150.3');
  });

  it('emits OFF + 0 power only for ids in changedToOff, not other absent devices', () => {
    const messages = frameMessages(baseFrame, ['d2']);
    const offState = messages.find((m) => m.topic === 'sense/device/d2/state');
    const offPower = messages.find((m) => m.topic === 'sense/device/d2/power');
    expect(offState?.payload).toBe('OFF');
    expect(offPower?.payload).toBe('0');

    // d3 was never in the frame nor in changedToOff, so nothing is emitted for it.
    expect(messages.find((m) => m.topic.includes('d3'))).toBeUndefined();
  });
});

describe('energyMessage', () => {
  it('produces a retained kWh message with 2 decimals', () => {
    expect(energyMessage(12.3456)).toEqual({ topic: 'sense/energy_today', payload: '12.35', retain: true });
  });
});

describe('alertMessages', () => {
  it('produces 3 retained ON/OFF messages reflecting state', () => {
    const messages = alertMessages({ brownout: true, neutral: false, stall: true });
    expect(messages).toEqual([
      { topic: 'sense/alert/brownout', payload: 'ON', retain: true },
      { topic: 'sense/alert/neutral', payload: 'OFF', retain: true },
      { topic: 'sense/alert/stall', payload: 'ON', retain: true },
    ]);
  });
});

describe('objectId', () => {
  it('sanitizes ids: lowercase, [a-z0-9_], runs of other chars collapse to one underscore', () => {
    expect(objectId('AC Unit #2')).toBe('ac_unit_2');
    expect(objectId('Living Room Lamp')).toBe('living_room_lamp');
    expect(objectId('already_ok_123')).toBe('already_ok_123');
    expect(objectId('--weird!!id--')).toBe('weird_id');
  });
});
