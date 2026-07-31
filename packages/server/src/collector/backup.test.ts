import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KvStore } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { runBackup } from './backup.js';
import { todayLocal } from '../lib/time.js';

const TZ = 'UTC';
const HOUR = 3600_000;

function makeCtx(dir: string): {
  config: { backupDir: string; dataDir: string; tz: string };
  db: Database.Database;
  kv: KvStore;
  log: (msg: string) => void;
  sense: { monitorTz: string | null };
  logs: string[];
} {
  const db = new Database(':memory:');
  migrate(db);
  const logs: string[] = [];
  return {
    config: { backupDir: dir, dataDir: dir, tz: TZ },
    db,
    kv: new KvStore(db),
    log: (msg: string) => logs.push(msg),
    sense: { monitorTz: TZ },
    logs,
  };
}

describe('runBackup', () => {
  let dir: string;
  let ctx: ReturnType<typeof makeCtx>;
  const now = Date.UTC(2026, 6, 31, 10, 0, 0);
  const todayFile = (): string => join(dir, `sense-${todayLocal(TZ, now)}.db`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sense-backup-'));
    ctx = makeCtx(dir);
  });

  afterEach(() => {
    ctx.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a snapshot when none has been taken', () => {
    expect(runBackup(ctx, now)).toBe('written');
    expect(existsSync(todayFile())).toBe(true);
    expect(statSync(todayFile()).size).toBeGreaterThan(0);
    expect(ctx.logs.some((m) => m.includes('backup: wrote'))).toBe(true);
  });

  it('skips a second run moments later', () => {
    expect(runBackup(ctx, now)).toBe('written');
    // Regression: the job runs on every process start, so a crash-looping
    // service used to rewrite the whole database every few seconds.
    expect(runBackup(ctx, now + 15_000)).toBe('skipped');
    expect(runBackup(ctx, now + 30_000)).toBe('skipped');
    expect(ctx.logs.filter((m) => m.includes('backup: wrote'))).toHaveLength(1);
    expect(ctx.logs.some((m) => m.includes('backup: skipped'))).toBe(true);
  });

  it('does not rewrite the file when skipping', () => {
    runBackup(ctx, now);
    const before = statSync(todayFile()).mtimeMs;
    runBackup(ctx, now + 60_000);
    expect(statSync(todayFile()).mtimeMs).toBe(before);
  });

  it('still runs once the interval has elapsed', () => {
    expect(runBackup(ctx, now)).toBe('written');
    expect(runBackup(ctx, now + 11 * HOUR)).toBe('skipped');
    expect(runBackup(ctx, now + 13 * HOUR)).toBe('written');
  });

  it('lets the daily scheduled run through', () => {
    expect(runBackup(ctx, now)).toBe('written');
    expect(runBackup(ctx, now + 24 * HOUR)).toBe('written');
  });

  it('rewrites when the recorded backup is missing from disk', () => {
    expect(runBackup(ctx, now)).toBe('written');
    rmSync(todayFile(), { force: true }); // pruned, or BACKUP_DIR repointed
    expect(runBackup(ctx, now + 60_000)).toBe('written');
    expect(existsSync(todayFile())).toBe(true);
  });

  it('creates the backup directory if it is absent', () => {
    const nested = join(dir, 'nas', 'sense');
    ctx.config.backupDir = nested;
    expect(runBackup(ctx, now)).toBe('written');
    expect(existsSync(join(nested, `sense-${todayLocal(TZ, now)}.db`))).toBe(true);
  });

  it('prunes old daily snapshots but keeps Sundays', () => {
    // 2026-07-26 and 2026-07-19 are Sundays.
    for (const day of [
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
      '2026-07-26',
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
    ]) {
      writeFileSync(join(dir, `sense-${day}.db`), 'x');
    }
    runBackup(ctx, now);
    const kept = readdirSync(dir).sort();
    expect(kept).toContain('sense-2026-07-19.db'); // Sunday, outside the daily window
    expect(kept).toContain('sense-2026-07-26.db'); // Sunday
    expect(kept).not.toContain('sense-2026-07-20.db');
  });
});
