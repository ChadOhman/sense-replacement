import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context.js';
import type { Scheduler } from './scheduler.js';
import { todayLocal } from '../lib/time.js';

const LAST_BACKUP_KEY = 'backup.last';
const KEEP_DAILY = 7;
const KEEP_WEEKLY = 4; // Sundays

export function getLastBackup(ctx: Pick<AppContext, 'kv'>): { ts: number; sizeBytes: number } | null {
  return ctx.kv.getJson<{ ts: number; sizeBytes: number }>(LAST_BACKUP_KEY);
}

/** Nightly consistent snapshots via VACUUM INTO, with daily+weekly pruning.
 *  BACKUP_DIR env points at e.g. a NAS mount; defaults to DATA_DIR/backups. */
export function registerBackupJob(ctx: AppContext, scheduler: Scheduler): void {
  const dir = ctx.config.backupDir || join(ctx.config.dataDir, 'backups');

  scheduler.register(
    'backup',
    24 * 3600_000,
    async () => {
      mkdirSync(dir, { recursive: true });
      const day = todayLocal(ctx.sense.monitorTz ?? ctx.config.tz);
      const path = join(dir, `sense-${day}.db`);
      rmSync(path, { force: true }); // re-running same day replaces
      ctx.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
      const size = statSync(path).size;
      ctx.kv.setJson(LAST_BACKUP_KEY, { ts: Math.floor(Date.now() / 1000), sizeBytes: size });
      prune(dir);
      ctx.log(`backup: wrote ${path} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    },
    { runImmediately: true },
  );
}

function prune(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => /^sense-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse(); // newest first
  const keep = new Set<string>(files.slice(0, KEEP_DAILY));
  let weekly = 0;
  for (const f of files) {
    if (weekly >= KEEP_WEEKLY) break;
    const day = f.slice(6, 16);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() === 0) {
      keep.add(f);
      weekly += 1;
    }
  }
  for (const f of files) {
    if (!keep.has(f)) rmSync(join(dir, f), { force: true });
  }
}
