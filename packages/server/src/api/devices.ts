import type { FastifyInstance } from 'fastify';
import type {
  Device,
  DeviceDetailResponse,
  DeviceEvent,
  DeviceListItem,
  DevicesResponse,
} from '@sense/shared';
import { getBillingSettings, type AppContext } from '../context.js';
import { addDays, monthOf, todayLocal } from '../lib/time.js';
import { getStoredAnomalies } from '../collector/health.js';
import { median, pairRuns } from '../lib/runs.js';
import { rateForHour } from '../lib/rates.js';

interface DeviceRow {
  id: string;
  name: string;
  type: string | null;
  icon: string | null;
  tags_json: string;
  is_guess: number;
  revoked: number;
  first_seen: number;
  last_seen: number;
}

function toDevice(r: DeviceRow): Device {
  let tags: Record<string, string> = {};
  try {
    tags = JSON.parse(r.tags_json) as Record<string, string>;
  } catch {
    /* keep empty */
  }
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    icon: r.icon,
    tags,
    isGuess: r.is_guess === 1,
    revoked: r.revoked === 1,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
}

export function registerDeviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const allDevicesStmt = ctx.db.prepare('SELECT * FROM devices');
  const oneDeviceStmt = ctx.db.prepare('SELECT * FROM devices WHERE id = ?');
  const dayKwhStmt = ctx.db.prepare(
    'SELECT COALESCE(SUM(kwh), 0) AS kwh FROM device_daily WHERE device_id = ? AND day = ?',
  );
  const monthKwhStmt = ctx.db.prepare(
    `SELECT COALESCE(SUM(kwh), 0) AS kwh FROM device_daily WHERE device_id = ? AND day LIKE ? || '%'`,
  );
  const dailyStmt = ctx.db.prepare(
    'SELECT day, kwh FROM device_daily WHERE device_id = ? AND day > ? ORDER BY day',
  );
  const monthlyStmt = ctx.db.prepare(
    `SELECT strftime('%Y-%m', day) AS month, SUM(kwh) AS kwh FROM device_daily
     WHERE device_id = ? AND day > ? GROUP BY month ORDER BY month`,
  );
  const eventsStmt = ctx.db.prepare(
    `SELECT e.id, e.device_id AS deviceId, d.name AS deviceName, e.ts, e.type, e.watts, e.source
     FROM events e JOIN devices d ON d.id = e.device_id
     WHERE e.device_id = ? ORDER BY e.ts DESC LIMIT 50`,
  );
  const runEnergyStmt = ctx.db.prepare(
    `SELECT COALESCE(SUM(w_avg * ?), 0) AS ws FROM device_power_rollup
     WHERE resolution = ? AND device_id = ? AND bucket >= ? AND bucket < ?`,
  );

  /** Median duration/energy/cost over recent completed runs. Energy comes from
   *  the device's own rollups during each run window; cost prices each run at
   *  the rate of its start hour. */
  const typicalRun = (deviceId: string, events: DeviceEvent[]) => {
    const runs = pairRuns(events.map((e) => ({ ts: e.ts, type: e.type }))).slice(-10);
    if (runs.length < 2) return null;
    const now = Math.floor(Date.now() / 1000);
    const { ratePlan } = getBillingSettings(ctx);
    const kwhs: number[] = [];
    const costs: number[] = [];
    for (const run of runs) {
      // 30s rollups cover the last 7 days; older runs use 5-min rollups.
      const resolution = run.onTs > now - 6 * 86400 ? 30 : 300;
      const ws = (
        runEnergyStmt.get(resolution, resolution, deviceId, run.onTs, run.offTs) as { ws: number }
      ).ws;
      if (ws <= 0) continue;
      const kwh = ws / 3_600_000;
      const tz = ctx.sense.monitorTz ?? ctx.config.tz;
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        month: 'numeric',
        hour: 'numeric',
        hour12: false,
        weekday: 'short',
      }).formatToParts(new Date(run.onTs * 1000));
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
      const cents = rateForHour(
        ratePlan,
        Number(get('month')),
        weekday < 0 ? 0 : weekday,
        Number(get('hour')) % 24,
      );
      kwhs.push(kwh);
      costs.push((kwh * cents) / 100);
    }
    if (kwhs.length < 2) return null;
    return {
      durationS: median(runs.map((r) => r.durationS))!,
      kwh: median(kwhs)!,
      cost: median(costs)!,
      runs: kwhs.length,
    };
  };

  app.get('/devices', async (): Promise<DevicesResponse> => {
    const tz = ctx.sense.monitorTz ?? ctx.config.tz;
    const today = todayLocal(tz);
    const month = monthOf(today);
    const liveById = new Map((ctx.ring.latest()?.devices ?? []).map((d) => [d.id, d.w]));
    const anomalies = getStoredAnomalies(ctx);
    const rows = allDevicesStmt.all() as DeviceRow[];
    const devices: DeviceListItem[] = rows.map((r) => {
      const todayKwh = (dayKwhStmt.get(r.id, today) as { kwh: number }).kwh;
      const monthKwh = (monthKwhStmt.get(r.id, month) as { kwh: number }).kwh;
      return {
        ...toDevice(r),
        nowW: liveById.get(r.id) ?? null,
        todayKwh,
        monthKwh,
        monthCost: ctx.costs.costForDeviceRange(r.id, `${month}-01`, today),
        anomaly: anomalies[r.id] ?? null,
      };
    });
    devices.sort((a, b) => (b.nowW ?? -1) - (a.nowW ?? -1) || a.name.localeCompare(b.name));
    return { devices };
  });

  app.get<{ Params: { id: string } }>('/devices/:id', async (req, reply): Promise<DeviceDetailResponse | void> => {
    const row = oneDeviceStmt.get(req.params.id) as DeviceRow | undefined;
    if (!row) return reply.status(404).send({ error: 'unknown device' });
    const tz = ctx.sense.monitorTz ?? ctx.config.tz;
    const today = todayLocal(tz);

    const dailyRows = dailyStmt.all(row.id, addDays(today, -30)) as { day: string; kwh: number }[];
    const dailyByDay = new Map(dailyRows.map((r) => [r.day, r.kwh]));
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const day = addDays(today, -i);
      const kwh = dailyByDay.get(day) ?? 0;
      daily.push({ day, kwh, cost: ctx.costs.costForDeviceDay(row.id, day) });
    }

    const monthly = (monthlyStmt.all(row.id, addDays(today, -365)) as { month: string; kwh: number }[]).map(
      (r) => {
        const monthStart = `${r.month}-01`;
        const nextMonth = addDays(`${r.month}-28`, 4).slice(0, 7);
        const monthEnd = addDays(`${nextMonth}-01`, -1);
        return {
          month: r.month,
          kwh: r.kwh,
          cost: ctx.costs.costForDeviceRange(row.id, monthStart, monthEnd < today ? monthEnd : today),
        };
      },
    );

    const events = eventsStmt.all(row.id) as DeviceEvent[];
    const liveById = new Map((ctx.ring.latest()?.devices ?? []).map((d) => [d.id, d.w]));

    return {
      device: toDevice(row),
      nowW: liveById.get(row.id) ?? null,
      daily,
      monthly,
      events,
      typicalRun: typicalRun(row.id, events),
    };
  });
}
