import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context.js';
import type { Scheduler } from './scheduler.js';
import { todayLocal } from '../lib/time.js';

const LAST_BACKUP_KEY = 'backup.last';
const KEEP_DAILY = 7;
const KEEP_WEEKLY = 4; // Sundays
/** The job runs on every process start so a monitor that was down overnight
 *  still gets a snapshot. Without a floor, a crash-looping service rewrites
 *  the whole database every few seconds, so skip runs this recent. Well under
 *  the 24h interval, which therefore always passes the guard. */
const MIN_BACKUP_INTERVAL_MS = 12 * 3600_000;

export function getLastBackup(ctx: Pick<AppContext, 'kv'>): { ts: number; sizeBytes: number } | null {
  return ctx.kv.getJson<{ ts: number; sizeBytes: number }>(LAST_BACKUP_KEY);
}

/** BACKUP_DIR env points at e.g. a NAS mount; defaults to DATA_DIR/backups. */
export function backupDirFor(ctx: Pick<AppContext, 'config'>): string {
  return ctx.config.backupDir || join(ctx.config.dataDir, 'backups');
}

export type BackupOutcome = 'written' | 'skipped';

/** Snapshot the database, unless a recent one is already on disk. Exported so
 *  the skip guard is directly testable; the scheduler calls it via
 *  registerBackupJob. */
export function runBackup(
  ctx: Pick<AppContext, 'config' | 'db' | 'kv' | 'log' | 'sense'>,
  now = Date.now(),
): BackupOutcome {
  const dir = backupDirFor(ctx);
  mkdirSync(dir, { recursive: true });
  const day = todayLocal(ctx.sense.monitorTz ?? ctx.config.tz, now);
  const path = join(dir, `sense-${day}.db`);

  // Require the file too: if it was pruned, moved, or BACKUP_DIR was
  // repointed at an empty mount, a fresh snapshot is worth the writes.
  const last = getLastBackup(ctx);
  if (last && now - last.ts * 1000 < MIN_BACKUP_INTERVAL_MS && existsSync(path)) {
    const ageMin = Math.round((now - last.ts * 1000) / 60_000);
    ctx.log(`backup: skipped, ${path} was written ${ageMin}m ago`);
    return 'skipped';
  }

  rmSync(path, { force: true }); // re-running same day replaces
  ctx.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  const size = statSync(path).size;
  ctx.kv.setJson(LAST_BACKUP_KEY, { ts: Math.floor(now / 1000), sizeBytes: size });
  prune(dir);
  ctx.log(`backup: wrote ${path} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return 'written';
}

/** Nightly consistent snapshots via VACUUM INTO, with daily+weekly pruning. */
export function registerBackupJob(ctx: AppContext, scheduler: Scheduler): void {
  scheduler.register(
    'backup',
    24 * 3600_000,
    async () => {
      runBackup(ctx);
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
