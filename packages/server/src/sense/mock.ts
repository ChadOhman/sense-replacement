import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthState } from '@sense/shared';
import type { SenseClient, SenseRealtimeEvents } from './client.js';
import type {
  SenseDevice,
  SenseRealtimePayload,
  SenseTimeline,
  SenseTrends,
  TrendScale,
} from './types.js';

/**
 * Fixture-replay / synthetic Sense client for development (SENSE_MOCK=1).
 * If recorded fixtures exist (fixtures/devices.json, fixtures/frames.jsonl —
 * produced by scripts/record-fixtures.ts) they are replayed; otherwise a
 * deterministic synthetic household is simulated. Zero load on Sense's cloud.
 */

const MOCK_DEVICES: SenseDevice[] = [
  { id: 'fridge1', name: 'Fridge', icon: 'fridge', type: 'Refrigerator', tags: {} },
  { id: 'ac1', name: 'Air Conditioner', icon: 'ac', type: 'AC', tags: {} },
  { id: 'dryer1', name: 'Dryer', icon: 'dryer', type: 'Dryer', tags: {} },
  { id: 'oven1', name: 'Oven', icon: 'stove', type: 'Oven', tags: {} },
  { id: 'ev1', name: 'EV Charger', icon: 'car', type: 'ElectricVehicle', tags: {} },
  { id: 'always_on', name: 'Always On', icon: 'alwayson', type: 'AlwaysOn', tags: {} },
  { id: 'unknown', name: 'Other', icon: 'home', type: 'Unknown', tags: {} },
];

/** Deterministic pseudo-random in [0,1) seeded by an integer. */
function prand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Simulated device wattage at a given epoch second. */
function deviceWatts(deviceId: string, ts: number): number {
  const hour = (ts % 86400) / 3600;
  const minute = Math.floor(ts / 60);
  switch (deviceId) {
    case 'always_on':
      return 145 + 10 * Math.sin(ts / 900);
    case 'fridge1':
      // ~10 min compressor cycles, on ~40% of the time
      return prand(Math.floor(ts / 600)) < 0.4 ? 120 + 15 * Math.sin(ts / 60) : 0;
    case 'ac1':
      // afternoon/evening duty cycles
      return hour > 12 && hour < 22 && prand(Math.floor(ts / 1200)) < 0.6 ? 1800 : 0;
    case 'dryer1':
      return hour >= 18 && hour < 19 ? 4800 : 0;
    case 'oven1':
      return (hour >= 17.5 && hour < 18.25) || (hour >= 7 && hour < 7.5) ? 2400 : 0;
    case 'ev1':
      return hour >= 1 && hour < 5 ? 7200 : 0;
    case 'unknown':
      return 80 + 60 * prand(minute);
    default:
      return 0;
  }
}

/** Simulated solar production: daylight bell curve peaking ~4 kW. */
function solarWatts(ts: number): number {
  const hour = (ts % 86400) / 3600;
  if (hour < 6 || hour > 20) return 0;
  const x = (hour - 13) / 7; // -1..1 across the daylight window
  return Math.max(0, 4000 * Math.cos((x * Math.PI) / 2) ** 2 + 50 * Math.sin(ts / 30));
}

function totalFrame(ts: number, solar: boolean): SenseRealtimePayload {
  const devices = MOCK_DEVICES.filter((d) => d.id !== 'unknown')
    .map((d) => ({ id: d.id, name: d.name, icon: d.icon ?? null, w: deviceWatts(d.id, ts) }))
    .filter((d) => d.w > 1);
  const other = deviceWatts('unknown', ts);
  let w = devices.reduce((s, d) => s + d.w, 0) + other;
  // Simulated motor stall: every hour, four ~1800 W failed-start spikes
  // (6 s each, 30 s apart) from an undetected motor. Offset from the
  // brownout (t%600 in [300,320)) and neutral (t%1800 in [1200,1215)) windows.
  const stallPos = ts % 3600;
  if (stallPos >= 2400 && stallPos < 2520 && (stallPos - 2400) % 30 < 6) {
    w += 1800;
  }
  // Simulated brownout: 20-second sag on leg 1 to ~104 V every 10 minutes
  // (starting 5 min into each cycle) so the detection pipeline is exercised.
  const cyclePos = ts % 600;
  const sagging = cyclePos >= 300 && cyclePos < 320;
  // Simulated floating neutral: 15-second anti-correlated divergence
  // (leg 1 up, leg 2 down) every 30 minutes, offset to never overlap the sag.
  const diverging = ts % 1800 >= 1200 && ts % 1800 < 1215;
  let leg1 = 121.2 + Math.sin(ts / 45);
  let leg2 = 121.5 + Math.cos(ts / 50);
  if (sagging) leg1 = 104 + Math.sin(ts / 3);
  else if (diverging) {
    leg1 = 129 + Math.sin(ts / 3);
    leg2 = 113 - Math.sin(ts / 3);
  }
  return {
    w,
    ...(solar ? { solar_w: solarWatts(ts) } : {}),
    hz: 60 + 0.02 * Math.sin(ts / 30),
    voltage: [leg1, leg2],
    devices,
  };
}

/** Simulated daily kWh for a given local day string, deterministic. */
function dailyKwh(day: string): { total: number; perDevice: Map<string, number> } {
  const seed = Number(day.replaceAll('-', ''));
  const perDevice = new Map<string, number>();
  perDevice.set('always_on', 3.5);
  perDevice.set('fridge1', 1.1 + 0.3 * prand(seed + 1));
  perDevice.set('ac1', 6 + 8 * prand(seed + 2));
  perDevice.set('dryer1', prand(seed + 3) < 0.4 ? 4.5 : 0);
  perDevice.set('oven1', 1.5 + prand(seed + 4));
  perDevice.set('ev1', prand(seed + 5) < 0.5 ? 28 : 0);
  perDevice.set('unknown', 2 + 2 * prand(seed + 6));
  let total = 0;
  for (const v of perDevice.values()) total += v;
  return { total, perDevice };
}

class MockRealtime extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  solar = false;
  private frames: { payload: SenseRealtimePayload }[] | null = null;
  private frameIdx = 0;
  private _connected = false;

  constructor(fixturesDir: string) {
    super();
    const framesPath = join(fixturesDir, 'frames.jsonl');
    if (existsSync(framesPath)) {
      this.frames = readFileSync(framesPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { payload: SenseRealtimePayload });
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    if (this.timer) return;
    this._connected = true;
    this.emit('connected');
    this.timer = setInterval(() => {
      const ts = Math.floor(Date.now() / 1000);
      let payload: SenseRealtimePayload;
      if (this.frames && this.frames.length > 0) {
        payload = this.frames[this.frameIdx % this.frames.length]!.payload;
        this.frameIdx += 1;
      } else {
        payload = totalFrame(ts, this.solar);
      }
      this.emit('frame', payload, ts);
    }, 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this._connected) {
      this._connected = false;
      this.emit('disconnected');
    }
  }
}

export class SenseMockClient implements SenseClient {
  readonly authState: AuthState = 'ok';
  private readonly solar: boolean;
  readonly authMessage = null;
  readonly monitorId = 999999;
  readonly monitorTz: string;
  private readonly rt: MockRealtime;
  private devicesFixture: SenseDevice[] | null = null;

  constructor(tz: string, fixturesDir = 'fixtures', solar = false) {
    this.monitorTz = tz;
    this.solar = solar;
    this.rt = new MockRealtime(fixturesDir);
    this.rt.solar = solar;
    const devicesPath = join(fixturesDir, 'devices.json');
    if (existsSync(devicesPath)) {
      this.devicesFixture = JSON.parse(readFileSync(devicesPath, 'utf8')) as SenseDevice[];
    }
  }

  async start(): Promise<void> {
    /* nothing to authenticate */
  }
  async submitMfa(): Promise<void> {
    /* never needed */
  }
  async stop(): Promise<void> {
    this.rt.stop();
  }

  async getDevices(): Promise<SenseDevice[]> {
    return this.devicesFixture ?? MOCK_DEVICES;
  }

  async getTrends(scale: TrendScale, startIso: string): Promise<SenseTrends> {
    const day = startIso.slice(0, 10);
    // History begins 400 days ago in mock mode so backfill terminates.
    // Math.round so "today" (whose noon-UTC anchor may be hours ahead of now)
    // still counts as age 0 rather than -1.
    const ageDays = Math.round((Date.now() - new Date(`${day}T12:00:00Z`).getTime()) / 86400000);
    if (scale !== 'DAY' || ageDays > 400 || ageDays < 0) {
      return { consumption: { total: 0, devices: [] } };
    }
    const { total, perDevice } = dailyKwh(day);
    return {
      start: `${day}T00:00:00`,
      ...(this.solar ? { production: { total: 18 + 10 * prand(Number(day.replaceAll('-', '')) + 9) } } : {}),
      consumption: {
        total,
        devices: [...perDevice.entries()].map(([id, kwh]) => {
          const meta = MOCK_DEVICES.find((d) => d.id === id);
          return { id, name: meta?.name ?? id, icon: meta?.icon ?? null, total_kwh: kwh };
        }),
      },
    };
  }

  async getTimeline(): Promise<SenseTimeline> {
    const now = Date.now();
    const items = [];
    // Reconstruct recent on/off transitions from the simulated schedule.
    for (let m = 60; m >= 1; m--) {
      const ts = Math.floor(now / 1000 / 60 - m) * 60;
      for (const d of MOCK_DEVICES) {
        if (d.id === 'unknown' || d.id === 'always_on') continue;
        const before = deviceWatts(d.id, ts - 60) > 1;
        const after = deviceWatts(d.id, ts) > 1;
        if (before !== after) {
          items.push({
            time: new Date(ts * 1000).toISOString(),
            type: after ? 'DeviceOn' : 'DeviceOff',
            device_id: d.id,
          });
        }
      }
    }
    return { items };
  }

  get realtime(): SenseRealtimeEvents {
    return this.rt as unknown as SenseRealtimeEvents;
  }
  startRealtime(): void {
    this.rt.start();
  }
  stopRealtime(): void {
    this.rt.stop();
  }
  get realtimeConnected(): boolean {
    return this.rt.connected;
  }
}
