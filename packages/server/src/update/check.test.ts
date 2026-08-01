import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VersionInfo } from '@sense/shared';
import { KvStore } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { checkForUpdate, getUpdateCheck, isUpdateAvailable, manifestSchema } from './check.js';

const MANIFEST = {
  sha: 'b'.repeat(40),
  shortSha: 'bbbbbbb',
  builtAt: '2026-07-30T00:00:00Z',
  tarball: 'sense-bbbbbbb.tar.gz',
  sha256: 'c'.repeat(64),
  sizeBytes: 12_345_678,
};

const CURRENT: VersionInfo = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', builtAt: null };
const DEV: VersionInfo = { sha: 'dev', shortSha: 'dev', builtAt: null };

const okFetch = (body: unknown): typeof fetch =>
  (() => Promise.resolve(new Response(JSON.stringify(body)))) as typeof fetch;

describe('manifestSchema', () => {
  it('accepts a valid manifest', () => {
    expect(manifestSchema.safeParse(MANIFEST).success).toBe(true);
  });

  it('rejects path traversal in the tarball name', () => {
    expect(manifestSchema.safeParse({ ...MANIFEST, tarball: '../evil.tar.gz' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...MANIFEST, tarball: 'a/b.tar.gz' }).success).toBe(false);
  });

  it('rejects a malformed checksum', () => {
    expect(manifestSchema.safeParse({ ...MANIFEST, sha256: 'nope' }).success).toBe(false);
  });
});

describe('checkForUpdate', () => {
  let db: Database.Database;
  let kv: KvStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    kv = new KvStore(db);
  });

  afterEach(() => db.close());

  it('stores a valid manifest', async () => {
    const result = await checkForUpdate(kv, 'http://x/manifest.json', okFetch(MANIFEST));
    expect(result.latest?.sha).toBe(MANIFEST.sha);
    expect(result.error).toBeNull();
    expect(getUpdateCheck(kv)?.latest?.sha).toBe(MANIFEST.sha);
  });

  it('records an error and keeps the previous manifest on failure', async () => {
    await checkForUpdate(kv, 'http://x/manifest.json', okFetch(MANIFEST));
    const failing = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    const result = await checkForUpdate(kv, 'http://x/manifest.json', failing);
    expect(result.error).toBe('offline');
    expect(result.latest?.sha).toBe(MANIFEST.sha); // kept
  });

  it('records an error on invalid manifest', async () => {
    const result = await checkForUpdate(kv, 'http://x/manifest.json', okFetch({ nope: true }));
    expect(result.error).toContain('invalid manifest');
    expect(result.latest).toBeNull();
  });

  it('records an error on HTTP failure', async () => {
    const notFound = (() => Promise.resolve(new Response('', { status: 404 }))) as typeof fetch;
    const result = await checkForUpdate(kv, 'http://x/manifest.json', notFound);
    expect(result.error).toBe('HTTP 404');
  });

  describe('isUpdateAvailable', () => {
    it('true when latest differs from current', async () => {
      await checkForUpdate(kv, 'http://x/manifest.json', okFetch(MANIFEST));
      expect(isUpdateAvailable(kv, CURRENT)).toBe(true);
    });

    it('false when already on latest', async () => {
      await checkForUpdate(kv, 'http://x/manifest.json', okFetch({ ...MANIFEST, sha: CURRENT.sha }));
      expect(isUpdateAvailable(kv, CURRENT)).toBe(false);
    });

    it('false for dev builds', async () => {
      await checkForUpdate(kv, 'http://x/manifest.json', okFetch(MANIFEST));
      expect(isUpdateAvailable(kv, DEV)).toBe(false);
    });

    it('false with no check result', () => {
      expect(isUpdateAvailable(kv, CURRENT)).toBe(false);
    });
  });
});
