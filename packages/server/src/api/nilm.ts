import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  NilmClustersResponse,
  NilmDevice,
  NilmDevicesResponse,
  NilmReclusterResponse,
  NilmStatusResponse,
} from '@sense/shared';
import type { AppContext } from '../context.js';

const deviceBodySchema = z.object({
  name: z.string().min(1).max(80),
  icon: z.string().max(16).nullable().optional(),
  estW: z.number().min(1).max(50000).nullable().optional(),
  offDelayS: z.number().int().min(30).max(86400).nullable().optional(),
  maxMatchDistance: z.number().min(1).max(10000).nullable().optional(),
});

const clusterAssignSchema = z.object({
  deviceId: z.number().int().nullable(),
});

function listDevices(ctx: AppContext): NilmDevice[] {
  const rows = ctx.db
    .prepare(
      'SELECT id, name, icon, est_w, off_delay_s, max_match_distance, created_ts FROM nilm_devices ORDER BY name',
    )
    .all() as {
    id: number;
    name: string;
    icon: string | null;
    est_w: number | null;
    off_delay_s: number | null;
    max_match_distance: number | null;
    created_ts: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    estW: r.est_w,
    offDelayS: r.off_delay_s,
    maxMatchDistance: r.max_match_distance,
    createdTs: r.created_ts,
  }));
}

export function registerNilmRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/nilm/status', async (): Promise<NilmStatusResponse> => {
    const counts = ctx.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM nilm_events) AS events,
           (SELECT COUNT(*) FROM nilm_events WHERE cluster_id IS NULL) AS unclustered,
           (SELECT COUNT(*) FROM nilm_clusters) AS clusters,
           (SELECT COUNT(*) FROM nilm_devices) AS devices`,
      )
      .get() as { events: number; unclustered: number; clusters: number; devices: number };
    const lastRun = ctx.kv.get('nilm.lastClusterRun');
    return {
      eventCount: counts.events,
      unclusteredCount: counts.unclustered,
      clusterCount: counts.clusters,
      deviceCount: counts.devices,
      lastClusterRunTs: lastRun !== null ? Number(lastRun) : null,
      live: ctx.getNilmState(),
    };
  });

  app.get('/nilm/clusters', async (): Promise<NilmClustersResponse> => {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const rows = ctx.db
      .prepare(
        `SELECT c.id, c.direction, c.profile_json, c.radius, c.size, c.device_id,
                MAX(e.ts) AS last_seen,
                SUM(CASE WHEN e.ts >= ? THEN 1 ELSE 0 END) AS recent
         FROM nilm_clusters c LEFT JOIN nilm_events e ON e.cluster_id = c.id
         GROUP BY c.id
         ORDER BY c.device_id IS NOT NULL, c.size DESC`,
      )
      .all(weekAgo) as {
      id: number;
      direction: 'on' | 'off';
      profile_json: string;
      radius: number;
      size: number;
      device_id: number | null;
      last_seen: number | null;
      recent: number | null;
    }[];
    return {
      clusters: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        profile: JSON.parse(r.profile_json) as number[],
        radius: r.radius,
        size: r.size,
        deviceId: r.device_id,
        lastSeenTs: r.last_seen,
        occurrences7d: r.recent ?? 0,
      })),
    };
  });

  app.put('/nilm/clusters/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = clusterAssignSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    if (parsed.data.deviceId !== null) {
      const device = ctx.db.prepare('SELECT 1 FROM nilm_devices WHERE id = ?').get(parsed.data.deviceId);
      if (!device) return reply.status(404).send({ error: 'no such device' });
    }
    const res = ctx.db
      .prepare('UPDATE nilm_clusters SET device_id = ? WHERE id = ?')
      .run(parsed.data.deviceId, id);
    if (res.changes === 0) return reply.status(404).send({ error: 'no such cluster' });
    ctx.reloadNilmProfiles();
    return { ok: true };
  });

  app.post('/nilm/recluster', async (_req, reply): Promise<NilmReclusterResponse | void> => {
    try {
      return ctx.runNilmClustering();
    } catch (err) {
      return reply
        .status(503)
        .send({ error: err instanceof Error ? err.message : 'clustering unavailable' });
    }
  });

  app.get('/nilm/devices', async (): Promise<NilmDevicesResponse> => ({ devices: listDevices(ctx) }));

  app.post('/nilm/devices', async (req, reply): Promise<NilmDevicesResponse | void> => {
    const parsed = deviceBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const d = parsed.data;
    ctx.db
      .prepare(
        `INSERT INTO nilm_devices (name, icon, est_w, off_delay_s, max_match_distance, created_ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.name,
        d.icon ?? null,
        d.estW ?? null,
        d.offDelayS ?? null,
        d.maxMatchDistance ?? null,
        Math.floor(Date.now() / 1000),
      );
    ctx.reloadNilmProfiles();
    return { devices: listDevices(ctx) };
  });

  app.put('/nilm/devices/:id', async (req, reply): Promise<NilmDevicesResponse | void> => {
    const id = Number((req.params as { id: string }).id);
    const parsed = deviceBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const d = parsed.data;
    const res = ctx.db
      .prepare(
        `UPDATE nilm_devices SET name = ?, icon = ?, est_w = ?, off_delay_s = ?, max_match_distance = ?
         WHERE id = ?`,
      )
      .run(d.name, d.icon ?? null, d.estW ?? null, d.offDelayS ?? null, d.maxMatchDistance ?? null, id);
    if (res.changes === 0) return reply.status(404).send({ error: 'no such device' });
    ctx.reloadNilmProfiles();
    return { devices: listDevices(ctx) };
  });

  app.delete('/nilm/devices/:id', async (req, reply): Promise<NilmDevicesResponse | void> => {
    const id = Number((req.params as { id: string }).id);
    // FK ON DELETE SET NULL detaches this device's clusters back to unlabeled.
    const res = ctx.db.prepare('DELETE FROM nilm_devices WHERE id = ?').run(id);
    if (res.changes === 0) return reply.status(404).send({ error: 'no such device' });
    ctx.reloadNilmProfiles();
    return { devices: listDevices(ctx) };
  });
}
