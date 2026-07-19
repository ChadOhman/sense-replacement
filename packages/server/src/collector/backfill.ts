import type { BackfillStatus } from '@sense/shared';
import type { AppContext } from '../context.js';
import type { KvStore } from '../db/index.js';
import type { Scheduler } from './scheduler.js';
import { addDays, todayLocal } from '../lib/time.js';

const CURSOR_KEY = 'backfill.cursor';
const DONE_KEY = 'backfill.done';
const DAYS_KEY = 'backfill.days';
const EMPTY_STREAK_KEY = 'backfill.emptyStreak';
const EMPTY_STREAK_LIMIT = 30;

export function getBackfillStatus(kv: KvStore): BackfillStatus {
  const done = kv.get(DONE_KEY) === '1';
  const cursor = kv.get(CURSOR_KEY);
  return {
    state: done ? 'done' : cursor ? 'running' : 'idle',
    cursor: done ? null : cursor,
    daysArchived: Number(kv.get(DAYS_KEY) ?? '0'),
  };
}

export function registerBackfillJob(ctx: AppContext, scheduler: Scheduler): void {
  // Never overwrite rows the live trends jobs already wrote.
  const insertDailyStmt = ctx.db.prepare(
    `INSERT INTO daily_summary (day, kwh, source, production_kwh) VALUES (?, ?, 'trends', ?)
     ON CONFLICT(day) DO NOTHING`,
  );
  const insertDeviceDailyStmt = ctx.db.prepare(
    `INSERT INTO device_daily (day, device_id, kwh) VALUES (?, ?, ?) ON CONFLICT(day, device_id) DO NOTHING`,
  );
  const deviceExistsStmt = ctx.db.prepare('SELECT 1 FROM devices WHERE id = ?');
  const tz = () => ctx.sense.monitorTz ?? ctx.config.tz;

  scheduler.register(
    'backfill',
    5_000,
    async () => {
      if (ctx.kv.get(DONE_KEY) === '1') return;
      const cursor = ctx.kv.get(CURSOR_KEY) ?? addDays(todayLocal(tz()), -1);
      const trends = await ctx.sense.getTrends('DAY', `${cursor}T00:00:00`);
      const kwh = trends.consumption?.total ?? 0;
      let emptyStreak = Number(ctx.kv.get(EMPTY_STREAK_KEY) ?? '0');
      let days = Number(ctx.kv.get(DAYS_KEY) ?? '0');
      if (kwh > 0) {
        ctx.db.transaction(() => {
          insertDailyStmt.run(cursor, kwh, trends.production?.total ?? null);
          for (const d of trends.consumption?.devices ?? []) {
            if (!d.total_kwh) continue;
            if (!deviceExistsStmt.get(d.id)) continue;
            insertDeviceDailyStmt.run(cursor, d.id, d.total_kwh);
          }
        })();
        days += 1;
        emptyStreak = 0;
      } else {
        emptyStreak += 1;
      }
      ctx.kv.set(DAYS_KEY, String(days));
      ctx.kv.set(EMPTY_STREAK_KEY, String(emptyStreak));
      if (emptyStreak >= EMPTY_STREAK_LIMIT) {
        ctx.kv.set(DONE_KEY, '1');
        ctx.log(`backfill: complete — ${days} days archived`);
        return;
      }
      ctx.kv.set(CURSOR_KEY, addDays(cursor, -1));
    },
    { runImmediately: true },
  );
}
