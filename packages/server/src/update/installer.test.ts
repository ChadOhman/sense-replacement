import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KvStore } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import type { UpdateEnv } from './env.js';
import { Updater } from './installer.js';
import { getUpdateState } from './state.js';

const TARGET_SHA = 'b'.repeat(40);

function manifestFor(body: Buffer) {
  return {
    sha: TARGET_SHA,
    shortSha: 'bbbbbbb',
    builtAt: '2026-07-30T00:00:00Z',
    tarball: 'sense-bbbbbbb.tar.gz',
    sha256: createHash('sha256').update(body).digest('hex'),
    sizeBytes: body.length,
  };
}

async function waitForPhase(kv: KvStore, phase: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(getUpdateState(kv).phase).toBe(phase);
    },
    { timeout: 5000, interval: 25 },
  );
}

describe('Updater', () => {
  let db: Database.Database;
  let kv: KvStore;
  let dir: string;
  let env: UpdateEnv;
  const logs: string[] = [];

  function makeUpdater(overrides: Partial<ConstructorParameters<typeof Updater>[0]> = {}): Updater {
    return new Updater({
      kv,
      env,
      manifestUrl: 'http://localhost/rel/manifest.json',
      log: (m) => logs.push(m),
      statfsFn: (() => ({ bavail: 1_000_000, bsize: 4096 })) as never,
      exitFn: () => undefined,
      ...overrides,
    });
  }

  function seedCheck(manifest: unknown): void {
    kv.setJson('update.check', { latest: manifest, checkedTs: 1, error: null });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    kv = new KvStore(db);
    dir = mkdtempSync(join(tmpdir(), 'sense-inst-'));
    env = { supported: true, reason: null, updateDir: dir, liveDir: join(dir, 'live') };
    logs.length = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects when unsupported', () => {
    env = { ...env, supported: false, reason: 'running in Docker — update by pulling a new image' };
    expect(() => makeUpdater().startUpdate()).toThrow(/not supported.*Docker/);
  });

  it('rejects with no check result', () => {
    expect(() => makeUpdater().startUpdate()).toThrow(/no update check result/);
  });

  it('rejects a rollback with no previous version', () => {
    expect(() => makeUpdater().startRollback()).toThrow(/no previous version/);
  });

  it('fails the run when disk space is short', async () => {
    const body = Buffer.from('tarball-bytes');
    seedCheck(manifestFor(body));
    const updater = makeUpdater({
      statfsFn: (() => ({ bavail: 10, bsize: 512 })) as never, // ~5 KB free
    });
    updater.startUpdate();
    await waitForPhase(kv, 'failed');
    expect(getUpdateState(kv).error).toContain('not enough free space');
  });

  it('fails the run on checksum mismatch without touching the live tree', async () => {
    const body = Buffer.from('tarball-bytes');
    const manifest = { ...manifestFor(body), sha256: 'd'.repeat(64) };
    seedCheck(manifest);
    const fetchFn = (() => Promise.resolve(new Response(body))) as typeof fetch;
    const updater = makeUpdater({ fetchFn });
    updater.startUpdate();
    await waitForPhase(kv, 'failed');
    expect(getUpdateState(kv).error).toContain('checksum mismatch');
    expect(existsSync(join(dir, 'pending.json'))).toBe(false);
  });

  it('is single-flight: a second start throws while one runs', async () => {
    const body = Buffer.from('tarball-bytes');
    seedCheck(manifestFor(body));
    // A fetch that never resolves keeps the first run in 'downloading'.
    const hang = (() => new Promise(() => undefined)) as typeof fetch;
    const updater = makeUpdater({ fetchFn: hang });
    updater.startUpdate();
    expect(() => updater.startUpdate()).toThrow(/already in progress/);
  });

  it('a KV phase left active also blocks a new run (cross-restart)', () => {
    const body = Buffer.from('tarball-bytes');
    seedCheck(manifestFor(body));
    kv.setJson('update.state', { ...getUpdateState(kv), phase: 'installing' });
    expect(() => makeUpdater().startUpdate()).toThrow(/already in progress/);
  });

  it('stages a rollback: pending.json written, exit requested', async () => {
    kv.setJson('update.previous', { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', builtAt: null });
    mkdirSync(join(dir, 'previous'), { recursive: true });
    writeFileSync(join(dir, 'previous', 'package.json'), '{}');
    const exitFn = vi.fn();
    const updater = makeUpdater({ exitFn });
    updater.startRollback();
    const pending = JSON.parse(readFileSync(join(dir, 'pending.json'), 'utf8')) as { action: string };
    expect(pending.action).toBe('rollback');
    expect(getUpdateState(kv).phase).toBe('rolling-back');
    await vi.waitFor(() => expect(exitFn).toHaveBeenCalledWith(0), { timeout: 2000 });
  });
});
