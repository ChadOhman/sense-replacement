import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { todayLocal } from '../lib/time.js';
import { objectId } from '../alerts/ha.js';

/** Prometheus text exposition format, hand-rolled — the surface is tiny. */
export function registerMetricsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const kwhTodayStmt = ctx.db.prepare(
    'SELECT COALESCE(SUM(kwh), 0) AS kwh FROM daily_summary WHERE day = ?',
  );

  app.get('/metrics', async (_req, reply) => {
    const lines: string[] = [];
    const push = (name: string, help: string, type: string, value: number | null, labels = ''): void => {
      if (value === null) return;
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name}${labels} ${value}`);
    };

    const frame = ctx.ring.latest();
    push('sense_power_watts', 'Total mains power draw', 'gauge', frame?.w ?? null);
    if (frame) {
      for (let i = 0; i < frame.voltageLegs.length; i++) {
        lines.push(`sense_voltage_volts{leg="${i + 1}"} ${frame.voltageLegs[i]}`);
      }
      if (frame.voltageLegs.length > 0) {
        lines.unshift('# TYPE sense_voltage_volts gauge');
        lines.unshift('# HELP sense_voltage_volts Per-leg mains voltage');
      }
      push('sense_frequency_hz', 'Mains frequency', 'gauge', frame.hz);
      for (const d of frame.devices) {
        lines.push(`sense_device_power_watts{device="${objectId(d.id)}",name=${JSON.stringify(d.name)}} ${d.w}`);
      }
    }

    const tz = ctx.sense.monitorTz ?? ctx.config.tz;
    const kwh = (kwhTodayStmt.get(todayLocal(tz)) as { kwh: number }).kwh;
    push('sense_energy_today_kwh', 'Energy used today', 'gauge', kwh);
    push('sense_cloud_connected', 'Sense realtime stream connected', 'gauge', ctx.sense.realtimeConnected ? 1 : 0);
    push('sense_brownout_active', 'Brownout in progress', 'gauge', ctx.getActiveBrownout() ? 1 : 0);
    push('sense_neutral_active', 'Floating-neutral divergence in progress', 'gauge', ctx.getActiveNeutralEpisode() ? 1 : 0);
    push('sense_stall_active', 'Motor stall cluster in progress', 'gauge', ctx.getActiveStall() ? 1 : 0);

    const now = Math.floor(Date.now() / 1000);
    for (const c of ctx.collectorStatus.values()) {
      if (c.lastSuccess !== null) {
        lines.push(`sense_collector_last_success_age_seconds{job="${c.name}"} ${now - c.lastSuccess}`);
      }
    }

    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });
}
