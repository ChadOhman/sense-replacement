import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { todayLocal } from '../lib/time.js';

const rangeSchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const powerSchema = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().positive(),
  resolution: z.coerce.number().pipe(z.union([z.literal(30), z.literal(300), z.literal(3600)])).default(3600),
});

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  return [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n';
}

export function registerExportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const dailyStmt = ctx.db.prepare(
    'SELECT day, kwh, source FROM daily_summary WHERE day >= ? AND day <= ? ORDER BY day',
  );
  const deviceDailyStmt = ctx.db.prepare(
    `SELECT dd.day, d.name, dd.device_id, dd.kwh FROM device_daily dd
     JOIN devices d ON d.id = dd.device_id
     WHERE dd.day >= ? AND dd.day <= ? ORDER BY dd.day, d.name`,
  );
  const powerStmt = ctx.db.prepare(
    `SELECT bucket, w_avg, w_min, w_max, volts, hz, sample_count FROM power_rollup
     WHERE resolution = ? AND bucket >= ? AND bucket < ? ORDER BY bucket`,
  );

  app.get('/export/usage.csv', async (req, reply) => {
    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const tz = ctx.sense.monitorTz ?? ctx.config.tz;
    const to = parsed.data.to ?? todayLocal(tz);
    const from = parsed.data.from ?? '2000-01-01';
    const days = dailyStmt.all(from, to) as { day: string; kwh: number; source: string }[];
    const rows = days.map((d) => [d.day, d.kwh.toFixed(3), ctx.costs.costForDay(d.day).toFixed(2), d.source]);
    return reply
      .type('text/csv')
      .header('Content-Disposition', `attachment; filename="usage-${from}-to-${to}.csv"`)
      .send(toCsv(['day', 'kwh', 'cost', 'source'], rows));
  });

  app.get('/export/devices.csv', async (req, reply) => {
    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const tz = ctx.sense.monitorTz ?? ctx.config.tz;
    const to = parsed.data.to ?? todayLocal(tz);
    const from = parsed.data.from ?? '2000-01-01';
    const rows = (deviceDailyStmt.all(from, to) as { day: string; name: string; device_id: string; kwh: number }[]).map(
      (r) => [r.day, r.name, r.device_id, r.kwh.toFixed(3)],
    );
    return reply
      .type('text/csv')
      .header('Content-Disposition', `attachment; filename="devices-${from}-to-${to}.csv"`)
      .send(toCsv(['day', 'device', 'device_id', 'kwh'], rows));
  });

  app.get('/export/power.csv', async (req, reply) => {
    const parsed = powerSchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { from, to, resolution } = parsed.data;
    const rows = (
      powerStmt.all(resolution, from, to) as {
        bucket: number;
        w_avg: number;
        w_min: number;
        w_max: number;
        volts: number | null;
        hz: number | null;
        sample_count: number;
      }[]
    ).map((r) => [
      r.bucket,
      new Date(r.bucket * 1000).toISOString(),
      r.w_avg.toFixed(1),
      r.w_min.toFixed(1),
      r.w_max.toFixed(1),
      r.volts?.toFixed(1) ?? '',
      r.hz?.toFixed(2) ?? '',
      r.sample_count,
    ]);
    return reply
      .type('text/csv')
      .header('Content-Disposition', `attachment; filename="power-${resolution}s.csv"`)
      .send(toCsv(['epoch', 'iso_utc', 'w_avg', 'w_min', 'w_max', 'volts', 'hz', 'samples'], rows));
  });

  /** Consistent snapshot of the whole database, streamed as a download. */
  app.get('/export/database', async (_req, reply) => {
    const tmpDir = join(ctx.config.dataDir, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const path = join(tmpDir, `export-${Date.now()}.db`);
    ctx.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    const size = (await stat(path)).size;
    const stream = createReadStream(path);
    stream.on('close', () => void rm(path, { force: true }));
    return reply
      .type('application/vnd.sqlite3')
      .header('Content-Length', size)
      .header(
        'Content-Disposition',
        `attachment; filename="sense-${todayLocal(ctx.sense.monitorTz ?? ctx.config.tz)}.db"`,
      )
      .send(stream);
  });
}
