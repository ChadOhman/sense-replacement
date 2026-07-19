import mqtt from 'mqtt';
import { onEvent, type AppContext } from '../context.js';
import { alertMessages, discoveryMessages, energyMessage, frameMessages } from './ha.js';
import { todayLocal } from '../lib/time.js';

const PUBLISH_INTERVAL_MS = 2000;
const DISCOVERY_REFRESH_MS = 6 * 3600_000;

/** Publishes live state + Home Assistant discovery to an MQTT broker.
 *  Enabled only when MQTT_URL is configured. */
export class MqttPublisher {
  private client: mqtt.MqttClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private lastFrameTs = 0;
  private pendingOff = new Set<string>();
  private lastAlertState = '';

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    const { mqttUrl, mqttUsername, mqttPassword } = this.ctx.config;
    if (!mqttUrl) return;
    this.client = mqtt.connect(mqttUrl, {
      username: mqttUsername || undefined,
      password: mqttPassword || undefined,
      will: { topic: 'sense/status', payload: 'offline', retain: true, qos: 0 },
      reconnectPeriod: 5000,
    });
    this.client.on('connect', () => {
      this.ctx.log('mqtt: connected');
      this.client!.publish('sense/status', 'online', { retain: true });
      void this.publishDiscovery();
    });
    this.client.on('error', (err) => this.ctx.log(`mqtt: ${err.message}`));

    onEvent(this.ctx, (event) => {
      if (event.type === 'device.off') this.pendingOff.add(event.deviceId);
    });

    this.timer = setInterval(() => this.tick(), PUBLISH_INTERVAL_MS);
    this.discoveryTimer = setInterval(() => void this.publishDiscovery(), DISCOVERY_REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.client) {
      this.client.publish('sense/status', 'offline', { retain: true });
      this.client.end();
      this.client = null;
    }
  }

  private async publishDiscovery(): Promise<void> {
    if (!this.client) return;
    const rows = this.ctx.db
      .prepare('SELECT id, name FROM devices WHERE revoked = 0')
      .all() as { id: string; name: string }[];
    for (const msg of discoveryMessages(rows)) {
      this.client.publish(msg.topic, msg.payload, { retain: msg.retain ?? false });
    }
  }

  private tick(): void {
    if (!this.client?.connected) return;
    const frame = this.ctx.ring.latest();
    if (frame && frame.ts !== this.lastFrameTs) {
      this.lastFrameTs = frame.ts;
      const off = [...this.pendingOff];
      this.pendingOff.clear();
      for (const msg of frameMessages(frame, off)) {
        this.client.publish(msg.topic, msg.payload, { retain: msg.retain ?? false });
      }
    }

    const tz = this.ctx.sense.monitorTz ?? this.ctx.config.tz;
    const kwhRow = this.ctx.db
      .prepare('SELECT COALESCE(SUM(kwh), 0) AS kwh FROM daily_summary WHERE day = ?')
      .get(todayLocal(tz)) as { kwh: number };
    const energy = energyMessage(kwhRow.kwh);
    this.client.publish(energy.topic, energy.payload, { retain: energy.retain ?? false });

    const alerts = {
      brownout: this.ctx.getActiveBrownout() !== null,
      neutral: this.ctx.getActiveNeutralEpisode() !== null,
      stall: this.ctx.getActiveStall() !== null,
    };
    const key = JSON.stringify(alerts);
    if (key !== this.lastAlertState) {
      this.lastAlertState = key;
      for (const msg of alertMessages(alerts)) {
        this.client.publish(msg.topic, msg.payload, { retain: msg.retain ?? false });
      }
    }
  }
}
