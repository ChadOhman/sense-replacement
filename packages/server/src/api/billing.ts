import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BillingResponse, BillingSettingsResponse } from '@sense/shared';
import { getBillingSettings, getSettings, saveBillingSettings, type AppContext } from '../context.js';
import { addDays, todayLocal } from '../lib/time.js';
import { cycleWindow, forecastCycleCost } from '../lib/rates.js';

const touPeriodSchema = z.object({
  name: z.string().min(1).max(40),
  months: z.array(z.number().int().min(1).max(12)).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  cents: z.number().nonnegative(),
});

const billingSettingsSchema = z.object({
  ratePlan: z.discriminatedUnion('type', [
    z.object({ type: z.literal('flat'), cents: z.number().nonnegative() }),
    z.object({
      type: z.literal('tou'),
      periods: z.array(touPeriodSchema).max(12),
      defaultCents: z.number().nonnegative(),
    }),
  ]),
  billingCycleDay: z.number().int().min(1).max(28),
});

export function registerBillingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const daysWithDataStmt = ctx.db.prepare(
    'SELECT day, kwh FROM daily_summary WHERE day >= ? AND day < ? ORDER BY day',
  );

  app.get('/billing/settings', async (): Promise<BillingSettingsResponse> => getBillingSettings(ctx));

  app.put('/billing/settings', async (req, reply): Promise<BillingSettingsResponse | void> => {
    const parsed = billingSettingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    saveBillingSettings(ctx, parsed.data);
    ctx.costs.invalidate();
    return getBillingSettings(ctx);
  });

  app.get('/billing', async (): Promise<BillingResponse> => {
    const tz = ctx.sense.monitorTz ?? ctx.config.tz;
    const today = todayLocal(tz);
    const { billingCycleDay } = getBillingSettings(ctx);
    const cycle = cycleWindow(today, billingCycleDay);

    const rows = daysWithDataStmt.all(cycle.startDay, addDays(today, 1)) as {
      day: string;
      kwh: number;
    }[];
    const toDateKwh = rows.reduce((s, r) => s + r.kwh, 0);
    const toDateCost = rows.reduce((s, r) => s + ctx.costs.costForDay(r.day), 0);

    // Recent complete days (before today), up to 14, for the run-rate forecast.
    const recent: number[] = [];
    for (let i = 1; i <= 14; i++) {
      const day = addDays(today, -i);
      const kwhRow = daysWithDataStmt.all(day, addDays(day, 1)) as { day: string; kwh: number }[];
      if (kwhRow.length > 0) recent.push(ctx.costs.costForDay(day));
    }
    const daysRemaining = cycle.daysInCycle - cycle.dayOfCycle;
    const forecast = forecastCycleCost(toDateCost, recent, daysRemaining);

    const prevCycle = cycleWindow(addDays(cycle.startDay, -1), billingCycleDay);
    const prevRows = daysWithDataStmt.all(prevCycle.startDay, prevCycle.endDay) as {
      day: string;
      kwh: number;
    }[];
    const lastCycleCost =
      prevRows.length > 0 ? prevRows.reduce((s, r) => s + ctx.costs.costForDay(r.day), 0) : null;

    return {
      cycleStartDay: cycle.startDay,
      cycleEndDay: cycle.endDay,
      dayOfCycle: cycle.dayOfCycle,
      daysInCycle: cycle.daysInCycle,
      toDateKwh,
      toDateCost,
      forecastCost: forecast,
      lastCycleCost,
      currency: getSettings(ctx).currency,
    };
  });
}
