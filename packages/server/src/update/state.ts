import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdatePhase, UpdateState, UpdateStep, VersionInfo } from '@sense/shared';
import type { KvStore } from '../db/index.js';

const STATE_KEY = 'update.state';
const PREVIOUS_KEY = 'update.previous';
const LOG_TAIL_MAX = 100;

const IDLE: UpdateState = {
  phase: 'idle',
  kind: 'update',
  fromSha: '',
  targetSha: null,
  startedTs: 0,
  updatedTs: 0,
  steps: [],
  error: null,
  logTail: [],
};

export function getUpdateState(kv: KvStore): UpdateState {
  return kv.getJson<UpdateState>(STATE_KEY) ?? IDLE;
}

export function getPreviousVersion(kv: KvStore): VersionInfo | null {
  return kv.getJson<VersionInfo>(PREVIOUS_KEY);
}

function save(kv: KvStore, state: UpdateState): UpdateState {
  state.updatedTs = Math.floor(Date.now() / 1000);
  kv.setJson(STATE_KEY, state);
  return state;
}

export function beginRun(
  kv: KvStore,
  kind: UpdateState['kind'],
  fromSha: string,
  targetSha: string | null,
  steps: string[],
): UpdateState {
  const now = Math.floor(Date.now() / 1000);
  return save(kv, {
    phase: kind === 'update' ? 'downloading' : 'rolling-back',
    kind,
    fromSha,
    targetSha,
    startedTs: now,
    updatedTs: now,
    steps: steps.map((name): UpdateStep => ({ name, status: 'pending' })),
    error: null,
    logTail: [],
  });
}

export function setPhase(kv: KvStore, phase: UpdatePhase): UpdateState {
  const state = getUpdateState(kv);
  state.phase = phase;
  return save(kv, state);
}

export function stepStart(kv: KvStore, name: string): void {
  const state = getUpdateState(kv);
  const step = state.steps.find((s) => s.name === name);
  if (step) step.status = 'active';
  save(kv, state);
}

export function stepOk(kv: KvStore, name: string, detail?: string): void {
  const state = getUpdateState(kv);
  const step = state.steps.find((s) => s.name === name);
  if (step) {
    step.status = 'ok';
    if (detail) step.detail = detail;
  }
  save(kv, state);
}

export function failRun(kv: KvStore, error: string): UpdateState {
  const state = getUpdateState(kv);
  state.phase = 'failed';
  state.error = error;
  const active = state.steps.find((s) => s.status === 'active');
  if (active) active.status = 'error';
  return save(kv, state);
}

export function appendLog(kv: KvStore, line: string): void {
  const state = getUpdateState(kv);
  state.logTail.push(line);
  if (state.logTail.length > LOG_TAIL_MAX) {
    state.logTail.splice(0, state.logTail.length - LOG_TAIL_MAX);
  }
  save(kv, state);
}

/** Resolve an in-flight update after the process restarts. Called on boot,
 *  before anything else can start a new run. */
export function reconcileOnBoot(kv: KvStore, current: VersionInfo, updateDir: string): void {
  // The wrapper leaves this flag when a new version crash-looped and it
  // swapped the previous tree back in.
  const revertedFlag = join(updateDir, 'reverted.flag');
  if (existsSync(revertedFlag)) {
    failRun(kv, `new version crash-looped after the swap; automatically reverted to ${current.shortSha} — see ${updateDir}/update.log`);
    try {
      rmSync(revertedFlag, { force: true });
    } catch {
      /* read-only fs would already have failed the swap */
    }
    return;
  }

  const state = getUpdateState(kv);
  switch (state.phase) {
    case 'restarting':
    case 'rolling-back': {
      if (state.targetSha !== null && state.targetSha === current.sha) {
        if (state.kind === 'update') {
          // Record what we replaced so the rollback slot is offered in the UI.
          kv.setJson(PREVIOUS_KEY, {
            sha: state.fromSha,
            shortSha: state.fromSha.slice(0, 7),
            builtAt: null,
          } satisfies VersionInfo);
        } else {
          // Rolled back: the rollback slot is spent.
          kv.delete(PREVIOUS_KEY);
        }
        state.phase = 'done';
        const restartStep = state.steps.find((s) => s.status !== 'ok');
        if (restartStep) restartStep.status = 'ok';
        save(kv, state);
      } else {
        failRun(
          kv,
          `restarted but still on ${current.shortSha} — the swap did not apply; see ${updateDir}/update.log`,
        );
      }
      break;
    }
    case 'downloading':
    case 'verifying':
    case 'installing':
      failRun(kv, 'interrupted by a restart before the update was staged');
      break;
    default:
      break; // idle / done / failed need nothing
  }
}
