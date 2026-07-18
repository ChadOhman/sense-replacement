import type { AppContext } from '../context.js';
import type { Scheduler } from './scheduler.js';

export function registerTimelineJob(ctx: AppContext, scheduler: Scheduler): void {
  const insertEventStmt = ctx.db.prepare(
    `INSERT OR IGNORE INTO events (device_id, ts, type, watts, source) VALUES (?, ?, ?, NULL, 'timeline')`,
  );
  const deviceExistsStmt = ctx.db.prepare('SELECT 1 FROM devices WHERE id = ?');

  scheduler.register(
    'timeline',
    5 * 60_000,
    async () => {
      const timeline = await ctx.sense.getTimeline();
      const items = [...timeline.items, ...(timeline.sticky_items ?? [])];
      ctx.db.transaction(() => {
        for (const item of items) {
          if (item.type !== 'DeviceOn' && item.type !== 'DeviceOff') continue;
          if (!item.device_id) continue;
          if (!deviceExistsStmt.get(item.device_id)) continue;
          const ts = Math.floor(Date.parse(item.time) / 1000);
          if (Number.isNaN(ts)) continue;
          insertEventStmt.run(item.device_id, ts, item.type === 'DeviceOn' ? 'on' : 'off');
        }
      })();
    },
    { runImmediately: true },
  );
}
