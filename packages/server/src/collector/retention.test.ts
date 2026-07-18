import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { compact30to300, compact300to3600, pruneOldRollups } from './retention.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare(
    `INSERT INTO devices (id, name, tags_json, first_seen, last_seen) VALUES ('dev1', 'Dev 1', '{}', 0, 0)`,
  ).run();
  return db;
}

const insertPower = (db: Database.Database) =>
  db.prepare(
    `INSERT INTO power_rollup (resolution, bucket, w_avg, w_min, w_max, volts, hz, sample_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
const insertDevicePower = (db: Database.Database) =>
  db.prepare(
    `INSERT INTO device_power_rollup (resolution, bucket, device_id, w_avg, sample_count) VALUES (?, ?, 'dev1', ?, ?)`,
  );

describe('compact30to300', () => {
  let db: Database.Database;
  const now = 1_000_000_000;

  beforeEach(() => {
    db = makeDb();
  });

  it('weights averages by sample_count and aggregates min/max', () => {
    const base = Math.floor((now - 7200) / 300) * 300; // an old, aligned 300s bucket
    insertPower(db).run(30, base, 100, 90, 110, 120, 60, 30);
    insertPower(db).run(30, base + 30, 200, 150, 260, 121, 60, 10);
    compact30to300(db, now);
    const row = db
      .prepare('SELECT * FROM power_rollup WHERE resolution = 300 AND bucket = ?')
      .get(base) as { w_avg: number; w_min: number; w_max: number; sample_count: number };
    expect(row).toBeDefined();
    expect(row.w_avg).toBeCloseTo((100 * 30 + 200 * 10) / 40);
    expect(row.w_min).toBe(90);
    expect(row.w_max).toBe(260);
    expect(row.sample_count).toBe(40);
  });

  it('does not compact buckets that are not yet fully past the age cutoff', () => {
    const recent = Math.floor((now - 60) / 300) * 300; // within the last hour
    insertPower(db).run(30, recent, 100, 100, 100, null, null, 30);
    compact30to300(db, now);
    const row = db
      .prepare('SELECT * FROM power_rollup WHERE resolution = 300 AND bucket = ?')
      .get(recent);
    expect(row).toBeUndefined();
  });

  it('compacts device rollups too', () => {
    const base = Math.floor((now - 7200) / 300) * 300;
    insertDevicePower(db).run(30, base, 50, 30);
    insertDevicePower(db).run(30, base + 30, 150, 30);
    compact30to300(db, now);
    const row = db
      .prepare(
        `SELECT * FROM device_power_rollup WHERE resolution = 300 AND bucket = ? AND device_id = 'dev1'`,
      )
      .get(base) as { w_avg: number; sample_count: number };
    expect(row.w_avg).toBeCloseTo(100);
    expect(row.sample_count).toBe(60);
  });

  it('is idempotent on re-run', () => {
    const base = Math.floor((now - 7200) / 300) * 300;
    insertPower(db).run(30, base, 100, 90, 110, null, null, 30);
    compact30to300(db, now);
    compact30to300(db, now);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM power_rollup WHERE resolution = 300')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('compact300to3600', () => {
  it('aggregates day-old 300s rows into hourly buckets', () => {
    const db = makeDb();
    const now = 1_000_000_000;
    const base = Math.floor((now - 2 * 86400) / 3600) * 3600;
    insertPower(db).run(300, base, 100, 80, 120, null, null, 300);
    insertPower(db).run(300, base + 300, 300, 250, 350, null, null, 100);
    compact300to3600(db, now);
    const row = db
      .prepare('SELECT * FROM power_rollup WHERE resolution = 3600 AND bucket = ?')
      .get(base) as { w_avg: number; w_min: number; w_max: number; sample_count: number };
    expect(row.w_avg).toBeCloseTo((100 * 300 + 300 * 100) / 400);
    expect(row.w_min).toBe(80);
    expect(row.w_max).toBe(350);
  });
});

describe('pruneOldRollups', () => {
  it('deletes only rows past the retention cutoff', () => {
    const db = makeDb();
    const now = 1_000_000_000;
    insertPower(db).run(30, now - 8 * 86400, 100, 100, 100, null, null, 30); // past 7d
    insertPower(db).run(30, now - 6 * 86400, 100, 100, 100, null, null, 30); // within 7d
    insertPower(db).run(300, now - 3 * 365 * 86400, 100, 100, 100, null, null, 300); // past 2y
    insertPower(db).run(300, now - 1 * 365 * 86400, 100, 100, 100, null, null, 300); // within 2y
    pruneOldRollups(db, now);
    const rows30 = db.prepare('SELECT bucket FROM power_rollup WHERE resolution = 30').all() as {
      bucket: number;
    }[];
    const rows300 = db.prepare('SELECT bucket FROM power_rollup WHERE resolution = 300').all() as {
      bucket: number;
    }[];
    expect(rows30).toHaveLength(1);
    expect(rows30[0]!.bucket).toBe(now - 6 * 86400);
    expect(rows300).toHaveLength(1);
    expect(rows300[0]!.bucket).toBe(now - 1 * 365 * 86400);
  });
});
