import type { AppContext } from '../context.js';
import type { Scheduler } from './scheduler.js';

export function registerDeviceSyncJob(ctx: AppContext, scheduler: Scheduler): void {
  // first_seen is deliberately absent from the DO UPDATE list so it is
  // preserved on conflict (set only on first insert).
  const upsertStmt = ctx.db.prepare(
    `INSERT INTO devices (id, name, type, icon, tags_json, is_guess, revoked, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, icon = excluded.icon,
       tags_json = excluded.tags_json, is_guess = excluded.is_guess,
       revoked = 0, last_seen = excluded.last_seen`,
  );
  const allIdsStmt = ctx.db.prepare('SELECT id FROM devices');
  const setRevokedStmt = ctx.db.prepare('UPDATE devices SET revoked = ? WHERE id = ?');

  scheduler.register(
    'device-sync',
    6 * 3600_000,
    async () => {
      const devices = await ctx.sense.getDevices();
      const now = Math.floor(Date.now() / 1000);
      const liveIds = new Set(devices.map((d) => d.id));
      ctx.db.transaction(() => {
        for (const d of devices) {
          const tags = (d.tags ?? {}) as Record<string, unknown>;
          const isGuess = tags['NameUserGuess'] ? 1 : 0;
          upsertStmt.run(d.id, d.name, d.type ?? null, d.icon ?? null, JSON.stringify(tags), isGuess, now, now);
        }
        const known = allIdsStmt.all() as { id: string }[];
        for (const { id } of known) {
          if (!liveIds.has(id)) setRevokedStmt.run(1, id);
        }
      })();
    },
    { runImmediately: true },
  );
}
