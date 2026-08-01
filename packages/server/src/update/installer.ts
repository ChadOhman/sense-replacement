import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { VersionInfo } from '@sense/shared';
import type { KvStore } from '../db/index.js';
import type { UpdateEnv } from './env.js';
import type { UpdateManifest } from './check.js';
import { getUpdateCheck } from './check.js';
import { getVersion } from './version.js';
import {
  appendLog,
  beginRun,
  failRun,
  getPreviousVersion,
  getUpdateState,
  setPhase,
  stepOk,
  stepStart,
} from './state.js';

const UPDATE_STEPS = ['Download', 'Verify checksum', 'Install dependencies', 'Stage new version'];
const ROLLBACK_STEPS = ['Prepare rollback'];
const PNPM_CANDIDATES = ['/usr/local/bin/pnpm', '/usr/bin/pnpm', 'pnpm'];
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Exit is delayed briefly so the HTTP response that triggered it can flush. */
const EXIT_DELAY_MS = 500;

export interface UpdaterDeps {
  kv: KvStore;
  env: UpdateEnv;
  /** Pinned manifest URL from config; tarball URLs are derived from it. */
  manifestUrl: string;
  log: (msg: string) => void;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  statfsFn?: typeof statfsSync;
  exitFn?: (code: number) => void;
}

/** Stages a new version (download → verify → install → stage) without ever
 *  touching the live tree, then writes pending.json and exits; the systemd
 *  wrapper (scripts/sense-run.sh) performs the swap while nothing runs. */
export class Updater {
  private busy = false;

  constructor(private readonly deps: UpdaterDeps) {}

  get isBusy(): boolean {
    return this.busy;
  }

  /** Throws on precondition failure; otherwise runs in the background. */
  startUpdate(): void {
    const { kv, env } = this.deps;
    if (!env.supported) throw new Error(`updates not supported: ${env.reason}`);
    if (this.busy || this.isPhaseActive()) throw new Error('an update is already in progress');
    const manifest = getUpdateCheck(kv)?.latest;
    if (!manifest) throw new Error('no update check result yet');
    const current = getVersion();
    if (manifest.sha === current.sha) throw new Error('already up to date');

    this.busy = true;
    beginRun(kv, 'update', current.sha, manifest.sha, UPDATE_STEPS);
    void this.runUpdate(manifest, current).catch((err) => {
      failRun(kv, err instanceof Error ? err.message : String(err));
      this.busy = false;
    });
  }

  /** Throws on precondition failure; otherwise exits shortly after. */
  startRollback(): void {
    const { kv, env } = this.deps;
    if (!env.supported) throw new Error(`updates not supported: ${env.reason}`);
    if (this.busy || this.isPhaseActive()) throw new Error('an update is already in progress');
    const previous = getPreviousVersion(kv);
    if (!previous || !existsSync(join(env.updateDir, 'previous', 'package.json'))) {
      throw new Error('no previous version available to roll back to');
    }

    this.busy = true;
    const current = getVersion();
    beginRun(kv, 'rollback', current.sha, previous.sha, ROLLBACK_STEPS);
    stepStart(kv, 'Prepare rollback');
    this.writePending({ action: 'rollback' });
    stepOk(kv, 'Prepare rollback');
    this.deps.log(`update: rollback to ${previous.shortSha} staged, restarting`);
    this.exitSoon();
  }

  private isPhaseActive(): boolean {
    const phase = getUpdateState(this.deps.kv).phase;
    return !['idle', 'done', 'failed'].includes(phase);
  }

  private async runUpdate(manifest: UpdateManifest, current: VersionInfo): Promise<void> {
    const { kv, env, log } = this.deps;
    log(`update: ${current.shortSha} -> ${manifest.shortSha} starting`);

    // Preflight: disk space for tarball + unpacked tree + node_modules.
    const statfs = this.deps.statfsFn ?? statfsSync;
    const free = (() => {
      try {
        const s = statfs(env.updateDir);
        return s.bavail * s.bsize;
      } catch {
        return Number.MAX_SAFE_INTEGER; // statfs unavailable — do not block
      }
    })();
    const needed = 3 * manifest.sizeBytes + 200 * 1024 * 1024;
    if (free < needed) {
      throw new Error(
        `not enough free space in ${env.updateDir}: ${(free / 1e6).toFixed(0)} MB free, need ~${(needed / 1e6).toFixed(0)} MB`,
      );
    }

    const downloadDir = join(env.updateDir, 'download');
    const stagingRoot = join(env.updateDir, 'staging');
    rmSync(downloadDir, { recursive: true, force: true });
    rmSync(stagingRoot, { recursive: true, force: true });
    mkdirSync(downloadDir, { recursive: true });

    // 1. Download. URL is built from the pinned manifest URL's directory —
    // never from client input (manifest.tarball is schema-limited to a bare
    // filename).
    stepStart(kv, 'Download');
    const tarPath = join(downloadDir, manifest.tarball);
    const base = new URL('.', this.deps.manifestUrl);
    const tarUrl = new URL(manifest.tarball, base).toString();
    appendLog(kv, `downloading ${tarUrl}`);
    const fetchFn = this.deps.fetchFn ?? fetch;
    const res = await fetchFn(tarUrl, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    // Buffered on purpose: artifacts are small (a few MB), and streaming the
    // fetch body via Readable.fromWeb can crash the whole process on an
    // internal undici assertion when the peer closes the socket unhelpfully.
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > 512 * 1024 * 1024) throw new Error('artifact implausibly large, refusing');
    writeFileSync(tarPath, body);
    stepOk(kv, 'Download', `${(manifest.sizeBytes / 1e6).toFixed(1)} MB`);

    // 2. Checksum.
    stepStart(kv, 'Verify checksum');
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== manifest.sha256) {
      throw new Error(`checksum mismatch: expected ${manifest.sha256}, got ${digest}`);
    }
    stepOk(kv, 'Verify checksum');

    // 3. Unpack + prod install, entirely inside staging.
    setPhase(kv, 'installing');
    stepStart(kv, 'Install dependencies');
    const stagingDir = join(stagingRoot, manifest.shortSha);
    mkdirSync(stagingDir, { recursive: true });
    await this.run('tar', ['-xzf', tarPath, '-C', stagingDir], stagingDir, 60_000);
    await this.run(
      this.resolvePnpm(),
      ['install', '--prod', '--frozen-lockfile'],
      stagingDir,
      INSTALL_TIMEOUT_MS,
    );
    stepOk(kv, 'Install dependencies');

    // 4. Sanity-check the staged tree before committing to a restart.
    stepStart(kv, 'Stage new version');
    const stagedEntry = join(stagingDir, 'packages/server/dist/index.js');
    if (!existsSync(stagedEntry)) throw new Error('staged tree is missing packages/server/dist/index.js');
    const stagedVersion = JSON.parse(
      readFileSync(join(stagingDir, 'packages/server/dist/version.json'), 'utf8'),
    ) as VersionInfo;
    if (stagedVersion.sha !== manifest.sha) {
      throw new Error(`staged version ${stagedVersion.shortSha} does not match manifest ${manifest.shortSha}`);
    }
    this.writePending({ action: 'apply', stagingDir, targetSha: manifest.sha });
    stepOk(kv, 'Stage new version');

    // 5. Hand off to the wrapper.
    setPhase(kv, 'restarting');
    log(`update: staged ${manifest.shortSha}, exiting for swap + restart`);
    this.exitSoon();
  }

  private writePending(pending: Record<string, unknown>): void {
    const path = join(this.deps.env.updateDir, 'pending.json');
    // Write-then-rename so the wrapper never reads a torn file.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(pending, null, 2));
    renameSync(tmp, path);
  }

  private exitSoon(): void {
    const exit = this.deps.exitFn ?? ((code: number) => process.exit(code));
    setTimeout(() => exit(0), EXIT_DELAY_MS);
  }

  private resolvePnpm(): string {
    for (const candidate of PNPM_CANDIDATES.slice(0, -1)) {
      if (existsSync(candidate)) return candidate;
    }
    return 'pnpm';
  }

  private run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
    const { kv } = this.deps;
    appendLog(kv, `$ ${cmd} ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, timeout: timeoutMs, env: { ...process.env, CI: '1' } });
      const capture = (data: Buffer): void => {
        for (const line of data.toString().split('\n')) {
          if (line.trim()) appendLog(kv, line.trimEnd());
        }
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with ${signal ?? code}`));
      });
    });
  }
}
