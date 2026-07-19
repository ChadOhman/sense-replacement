import type { AlertKind } from '@sense/shared';
import { getAlertSettings, onEvent, type AppContext } from '../context.js';
import type { AppEvent } from './events.js';
import { formatEvent, kindOf, shouldSend } from './rules.js';

/** Subscribes to the app event bus and delivers notifications via ntfy
 *  and/or a generic webhook, per the user's alert settings. */
export class Notifier {
  private readonly lastSent = new Map<AlertKind, number>();

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    onEvent(this.ctx, (event) => {
      void this.handle(event).catch((err) => {
        this.ctx.log(`notifier: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  private localHour(): number {
    const tz = this.ctx.sense.monitorTz ?? this.ctx.config.tz;
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(
        new Date(),
      ),
    );
  }

  private async handle(event: AppEvent): Promise<void> {
    const settings = getAlertSettings(this.ctx);
    if (!settings.ntfyUrl && !settings.webhookUrl) return;
    const kind = kindOf(event);
    if (!kind) return;
    const now = Math.floor(Date.now() / 1000);
    if (!shouldSend(event, settings, this.localHour(), this.lastSent.get(kind) ?? null, now)) {
      return;
    }
    this.lastSent.set(kind, now);
    const msg = formatEvent(event);
    const sends: Promise<void>[] = [];
    if (settings.ntfyUrl) {
      sends.push(
        fetch(settings.ntfyUrl, {
          method: 'POST',
          headers: {
            Title: msg.title,
            Priority: msg.priority === 'high' ? 'high' : 'default',
            Tags: msg.tags.join(','),
          },
          body: msg.body,
        }).then((res) => {
          if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
        }),
      );
    }
    if (settings.webhookUrl) {
      sends.push(
        fetch(settings.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: event.type, ts: event.ts, message: `${msg.title}: ${msg.body}`, data: event }),
        }).then((res) => {
          if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
        }),
      );
    }
    await Promise.all(sends);
    this.ctx.log(`notifier: sent "${msg.title}"`);
  }
}
