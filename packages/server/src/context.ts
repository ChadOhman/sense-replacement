import type { EventEmitter } from 'node:events';
import type { AlertSettings, AppStatus, BackfillStatus, CollectorStatus, Settings } from '@sense/shared';
import { DEFAULT_ALERT_SETTINGS } from '@sense/shared';
import type { Config } from './config.js';
import type { AppEvent } from './alerts/events.js';
import { EVENT_NAME } from './alerts/events.js';
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
  /** In-process app event bus (see alerts/events.ts). */
  events: EventEmitter;
  log: (msg: string) => void;
}

export function emitEvent(ctx: Pick<AppContext, 'events'>, event: AppEvent): void {
  ctx.events.emit(EVENT_NAME, event);
}

export function onEvent(ctx: Pick<AppContext, 'events'>, listener: (event: AppEvent) => void): void {
  ctx.events.on(EVENT_NAME, listener);
}

const ALERT_SETTINGS_KEY = 'settings.alerts';

export function getAlertSettings(ctx: Pick<AppContext, 'kv'>): AlertSettings {
  const stored = ctx.kv.getJson<Partial<AlertSettings>>(ALERT_SETTINGS_KEY);
  return {
    ...DEFAULT_ALERT_SETTINGS,
    ...stored,
    enabled: { ...DEFAULT_ALERT_SETTINGS.enabled, ...stored?.enabled },
  };
}

export function saveAlertSettings(ctx: Pick<AppContext, 'kv'>, settings: AlertSettings): void {
  ctx.kv.setJson(ALERT_SETTINGS_KEY, settings);
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
