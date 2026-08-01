import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VersionInfo } from '@sense/shared';
import { KvStore } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import {
  appendLog,
  beginRun,
  failRun,
  getPreviousVersion,
  getUpdateState,
  reconcileOnBoot,
  setPhase,
  stepOk,
  stepStart,
} from './state.js';

const OLD: VersionInfo = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', builtAt: '2026-07-01T00:00:00Z' };
const NEW: VersionInfo = { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', builtAt: '2026-07-30T00:00:00Z' };

describe('update state machine', () => {
  let db: Database.Database;
  let kv: KvStore;
  let dir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    kv = new KvStore(db);
    dir = mkdtempSync(join(tmpdir(), 'sense-update-'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts idle', () => {
    expect(getUpdateState(kv).phase).toBe('idle');
    expect(getPreviousVersion(kv)).toBeNull();
  });

  it('tracks steps through a run', () => {
    beginRun(kv, 'update', OLD.sha, NEW.sha, ['Download', 'Verify']);
    stepStart(kv, 'Download');
    stepOk(kv, 'Download', '12.0 MB');
    let s = getUpdateState(kv);
    expect(s.phase).toBe('downloading');
    expect(s.steps[0]).toMatchObject({ name: 'Download', status: 'ok', detail: '12.0 MB' });
    expect(s.steps[1]).toMatchObject({ status: 'pending' });
    setPhase(kv, 'restarting');
    s = getUpdateState(kv);
    expect(s.phase).toBe('restarting');
    expect(s.targetSha).toBe(NEW.sha);
  });

  it('failRun marks the active step as errored', () => {
    beginRun(kv, 'update', OLD.sha, NEW.sha, ['Download']);
    stepStart(kv, 'Download');
    failRun(kv, 'boom');
    const s = getUpdateState(kv);
    expect(s.phase).toBe('failed');
    expect(s.error).toBe('boom');
    expect(s.steps[0].status).toBe('error');
  });

  it('caps the log tail at 100 lines', () => {
    beginRun(kv, 'update', OLD.sha, NEW.sha, []);
    for (let i = 0; i < 150; i++) appendLog(kv, `line ${i}`);
    const s = getUpdateState(kv);
    expect(s.logTail).toHaveLength(100);
    expect(s.logTail[0]).toBe('line 50');
    expect(s.logTail[99]).toBe('line 149');
  });

  describe('reconcileOnBoot', () => {
    it('restarting + matching sha → done, previous recorded', () => {
      beginRun(kv, 'update', OLD.sha, NEW.sha, ['Download']);
      setPhase(kv, 'restarting');
      reconcileOnBoot(kv, NEW, dir);
      const s = getUpdateState(kv);
      expect(s.phase).toBe('done');
      expect(getPreviousVersion(kv)?.sha).toBe(OLD.sha);
    });

    it('restarting + mismatched sha → failed', () => {
      beginRun(kv, 'update', OLD.sha, NEW.sha, []);
      setPhase(kv, 'restarting');
      reconcileOnBoot(kv, OLD, dir); // came back on the old version
      const s = getUpdateState(kv);
      expect(s.phase).toBe('failed');
      expect(s.error).toContain('swap did not apply');
      expect(getPreviousVersion(kv)).toBeNull();
    });

    it('rollback + matching sha → done, previous slot spent', () => {
      kv.setJson('update.previous', OLD);
      beginRun(kv, 'rollback', NEW.sha, OLD.sha, []);
      reconcileOnBoot(kv, OLD, dir);
      expect(getUpdateState(kv).phase).toBe('done');
      expect(getPreviousVersion(kv)).toBeNull();
    });

    it('interrupted mid-download → failed', () => {
      beginRun(kv, 'update', OLD.sha, NEW.sha, []);
      reconcileOnBoot(kv, OLD, dir);
      const s = getUpdateState(kv);
      expect(s.phase).toBe('failed');
      expect(s.error).toContain('interrupted');
    });

    it('reverted.flag → failed with crash-loop message, flag removed', () => {
      beginRun(kv, 'update', OLD.sha, NEW.sha, []);
      setPhase(kv, 'restarting');
      writeFileSync(join(dir, 'reverted.flag'), '');
      reconcileOnBoot(kv, OLD, dir);
      const s = getUpdateState(kv);
      expect(s.phase).toBe('failed');
      expect(s.error).toContain('crash-looped');
      expect(existsSync(join(dir, 'reverted.flag'))).toBe(false);
    });

    it('idle / done / failed are left alone', () => {
      reconcileOnBoot(kv, OLD, dir);
      expect(getUpdateState(kv).phase).toBe('idle');
      beginRun(kv, 'update', OLD.sha, NEW.sha, []);
      failRun(kv, 'x');
      reconcileOnBoot(kv, OLD, dir);
      expect(getUpdateState(kv).error).toBe('x');
    });
  });
});
