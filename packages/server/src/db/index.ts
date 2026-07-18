import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from './migrate.js';

export type Db = Database.Database;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'sense.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('auto_vacuum = INCREMENTAL');
  migrate(db);
  return db;
}

export function dbSizeBytes(dataDir: string): number {
  try {
    return statSync(join(dataDir, 'sense.db')).size;
  } catch {
    return 0;
  }
}

/** Simple typed access to the kv table (tokens, cursors, settings). */
export class KvStore {
  private readonly getStmt;
  private readonly setStmt;
  private readonly delStmt;

  constructor(db: Db) {
    this.getStmt = db.prepare('SELECT value FROM kv WHERE key = ?');
    this.setStmt = db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.delStmt = db.prepare('DELETE FROM kv WHERE key = ?');
  }

  get(key: string): string | null {
    const row = this.getStmt.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  getJson<T>(key: string): T | null {
    const raw = this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    this.setStmt.run(key, value);
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.delStmt.run(key);
  }
}
