import type { FastifyInstance } from 'fastify';
import type {
  Device,
  DeviceDetailResponse,
  DeviceEvent,
  DeviceListItem,
  DevicesResponse,
} from '@sense/shared';
import { getSettings, kwhToCost, type AppContext } from '../context.js';
import { addDays, monthOf, todayLocal } from '../lib/time.js';

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

  app.get('/devices', async (): Promise<DevicesResponse> => {
    const tz = ctx.sense.monitorTz ?? ctx.config.tz;
    const today = todayLocal(tz);
    const month = monthOf(today);
    const settings = getSettings(ctx);
    const liveById = new Map((ctx.ring.latest()?.devices ?? []).map((d) => [d.id, d.w]));
    const rows = allDevicesStmt.all() as DeviceRow[];
    const devices: DeviceListItem[] = rows.map((r) => {
      const todayKwh = (dayKwhStmt.get(r.id, today) as { kwh: number }).kwh;
      const monthKwh = (monthKwhStmt.get(r.id, month) as { kwh: number }).kwh;
      return {
        ...toDevice(r),
        nowW: liveById.get(r.id) ?? null,
        todayKwh,
        monthKwh,
        monthCost: kwhToCost(monthKwh, settings),
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
    const settings = getSettings(ctx);

    const dailyRows = dailyStmt.all(row.id, addDays(today, -30)) as { day: string; kwh: number }[];
    const dailyByDay = new Map(dailyRows.map((r) => [r.day, r.kwh]));
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const day = addDays(today, -i);
      const kwh = dailyByDay.get(day) ?? 0;
      daily.push({ day, kwh, cost: kwhToCost(kwh, settings) });
    }

    const monthly = (monthlyStmt.all(row.id, addDays(today, -365)) as { month: string; kwh: number }[]).map(
      (r) => ({ month: r.month, kwh: r.kwh, cost: kwhToCost(r.kwh, settings) }),
    );

    const events = eventsStmt.all(row.id) as DeviceEvent[];
    const liveById = new Map((ctx.ring.latest()?.devices ?? []).map((d) => [d.id, d.w]));

    return {
      device: toDevice(row),
      nowW: liveById.get(row.id) ?? null,
      daily,
      monthly,
      events,
    };
  });
}
