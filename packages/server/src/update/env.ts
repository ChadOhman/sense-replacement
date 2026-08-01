import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { getVersion } from './version.js';

export interface UpdateEnv {
  supported: boolean;
  reason: string | null;
  /** Updater workspace (staging, previous, pending.json, ...). */
  updateDir: string;
  /** Root of the live tree ("/opt/sense" in production). */
  liveDir: string;
}

const DEFAULT_UPDATE_DIR = '/opt/sense-updates';

export function liveDirFromHere(): string {
  // Compiled location is <live>/packages/server/dist/update/env.js.
  return join(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

/** Whether self-update can work here, and why not when it can't.
 *  SENSE_UPDATE_DIR being set explicitly bypasses the linux check so the
 *  flow is testable on a dev machine. */
export function getUpdateEnv(config: Pick<Config, 'updateDir'>): UpdateEnv {
  const updateDir = config.updateDir || DEFAULT_UPDATE_DIR;
  const liveDir = process.env.SENSE_LIVE_DIR || liveDirFromHere();
  const unsupported = (reason: string): UpdateEnv => ({ supported: false, reason, updateDir, liveDir });

  if (existsSync('/.dockerenv')) {
    return unsupported('running in Docker — update by pulling a new image');
  }
  if (process.platform !== 'linux' && !config.updateDir) {
    return unsupported(`not a supported platform (${process.platform})`);
  }
  if (getVersion().sha === 'dev') {
    return unsupported('dev build — no version identity');
  }
  if (!existsSync(updateDir)) {
    return unsupported(`update directory ${updateDir} not found (one-time setup not done)`);
  }
  try {
    accessSync(updateDir, constants.W_OK);
  } catch {
    return unsupported(`update directory ${updateDir} is not writable`);
  }
  return { supported: true, reason: null, updateDir, liveDir };
}
