import type { EventEmitter } from 'node:events';
import type {
  AlertSettings,
  AppStatus,
  BackfillStatus,
  BillingSettings,
  CollectorStatus,
  Settings,
} from '@sense/shared';
import { DEFAULT_ALERT_SETTINGS } from '@sense/shared';
import type { CostEngine } from './lib/costs.js';
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
  /** Rate-aware cost calculations (lib/costs.ts); assigned in index.ts. */
  costs: CostEngine;
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

const BILLING_KEY = 'settings.billing';

/** Billing settings; defaults to a flat plan mirroring the legacy simple rate. */
export function getBillingSettings(ctx: Pick<AppContext, 'kv' | 'config'>): BillingSettings {
  const stored = ctx.kv.getJson<BillingSettings>(BILLING_KEY);
  if (stored) return stored;
  return {
    ratePlan: { type: 'flat', cents: getSettings(ctx).rateCentsPerKwh },
    billingCycleDay: 1,
  };
}

export function saveBillingSettings(ctx: Pick<AppContext, 'kv'>, settings: BillingSettings): void {
  ctx.kv.setJson(BILLING_KEY, settings);
}
