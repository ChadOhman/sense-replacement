import type { AppStatus, BackfillStatus, CollectorStatus, Settings } from '@sense/shared';
import type { Config } from './config.js';
import type { Db, KvStore } from './db/index.js';
import type { SenseClient } from './sense/client.js';
import type { LiveRingBuffer } from './lib/ringbuffer.js';

/** Everything the API routes and collectors share. Built once in index.ts. */
export interface AppContext {
  config: Config;
  db: Db;
  kv: KvStore;
  sense: SenseClient;
  ring: LiveRingBuffer;
  /** Collector health, keyed by job name; populated by the scheduler. */
  collectorStatus: Map<string, CollectorStatus>;
  getBackfillStatus: () => BackfillStatus;
  /** Assigned by startCollectors; null until collectors run. */
  getActiveBrownout: () => AppStatus['activeBrownout'];
  /** Assigned by startCollectors; null until collectors run. */
  getActiveNeutralEpisode: () => AppStatus['activeNeutralEpisode'];
  /** Assigned by startCollectors; null until collectors run. */
  getActiveStall: () => AppStatus['activeStall'];
  log: (msg: string) => void;
}

const SETTINGS_KEY = 'settings';

export function getSettings(ctx: Pick<AppContext, 'kv' | 'config'>): Settings {
  return (
    ctx.kv.getJson<Settings>(SETTINGS_KEY) ?? {
      rateCentsPerKwh: ctx.config.defaultRateCentsPerKwh,
      currency: ctx.config.currency,
    }
  );
}

export function saveSettings(ctx: Pick<AppContext, 'kv'>, settings: Settings): void {
  ctx.kv.setJson(SETTINGS_KEY, settings);
}

export function kwhToCost(kwh: number, settings: Settings): number {
  return (kwh * settings.rateCentsPerKwh) / 100;
}
