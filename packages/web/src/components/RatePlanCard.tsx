import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingSettings, SettingsResponse, TouPeriod } from '@sense/shared';
import { get, put } from '../api/client.js';

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

function newPeriod(): TouPeriod {
  return { name: 'On-peak', weekdays: [1, 2, 3, 4, 5], startHour: 16, endHour: 21, cents: 20 };
}

export function RatePlanCard() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => get<SettingsResponse>('/api/settings'),
  });
  const billing = useQuery({
    queryKey: ['billing-settings'],
    queryFn: () => get<BillingSettings>('/api/billing/settings'),
  });

  const [draft, setDraft] = useState<BillingSettings | null>(null);
  const [currency, setCurrency] = useState('');
  useEffect(() => {
    if (billing.data && !draft) setDraft(billing.data);
  }, [billing.data, draft]);
  useEffect(() => {
    if (settings.data) setCurrency(settings.data.currency);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: async (s: BillingSettings) => {
      await put('/api/billing/settings', s);
      const flatCents =
        s.ratePlan.type === 'flat' ? s.ratePlan.cents : s.ratePlan.defaultCents;
      await put('/api/settings', { rateCentsPerKwh: flatCents, currency: currency.toUpperCase() });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing-settings'] });
      void qc.invalidateQueries({ queryKey: ['billing'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  if (!draft) return null;
  const plan = draft.ratePlan;
  const setPlan = (ratePlan: BillingSettings['ratePlan']): void => setDraft({ ...draft, ratePlan });
  const inputStyle = { borderColor: 'var(--border)' };

  return (
    <div className="card space-y-4 p-4">
      <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
        Electricity plan
      </div>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--surface-2)' }}>
          {(['flat', 'tou'] as const).map((t) => (
            <button
              key={t}
              onClick={() =>
                setPlan(
                  t === 'flat'
                    ? { type: 'flat', cents: plan.type === 'tou' ? plan.defaultCents : plan.cents }
                    : {
                        type: 'tou',
                        periods: plan.type === 'tou' ? plan.periods : [newPeriod()],
                        defaultCents: plan.type === 'flat' ? plan.cents : plan.defaultCents,
                      },
                )
              }
              className="rounded-md px-3 py-1"
              style={{
                background: plan.type === t ? 'var(--series-1)' : 'transparent',
                color: plan.type === t ? '#fff' : 'var(--text-muted)',
              }}
            >
              {t === 'flat' ? 'Flat rate' : 'Time of use'}
            </button>
          ))}
        </div>
        <label>
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            {plan.type === 'flat' ? 'Rate (¢/kWh)' : 'Default rate (¢/kWh)'}
          </div>
          <input
            type="number"
            min={0}
            step={0.1}
            value={plan.type === 'flat' ? plan.cents : plan.defaultCents}
            onChange={(e) =>
              setPlan(
                plan.type === 'flat'
                  ? { ...plan, cents: Number(e.target.value) }
                  : { ...plan, defaultCents: Number(e.target.value) },
              )
            }
            className="w-24 rounded-md border bg-transparent px-2 py-1.5 tabular-nums"
            style={inputStyle}
          />
        </label>
        <label>
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            Currency
          </div>
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            maxLength={8}
            className="w-20 rounded-md border bg-transparent px-2 py-1.5 uppercase"
            style={inputStyle}
          />
        </label>
        <label>
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            Bill cycle starts on day
          </div>
          <input
            type="number"
            min={1}
            max={28}
            value={draft.billingCycleDay}
            onChange={(e) => setDraft({ ...draft, billingCycleDay: Number(e.target.value) })}
            className="w-20 rounded-md border bg-transparent px-2 py-1.5 tabular-nums"
            style={inputStyle}
          />
        </label>
      </div>

      {plan.type === 'tou' && (
        <div className="space-y-2">
          {plan.periods.map((p, i) => {
            const updatePeriod = (patch: Partial<TouPeriod>): void =>
              setPlan({
                ...plan,
                periods: plan.periods.map((pp, j) => (j === i ? { ...pp, ...patch } : pp)),
              });
            return (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm"
                style={{ background: 'var(--surface-2)' }}
              >
                <input
                  value={p.name}
                  onChange={(e) => updatePeriod({ name: e.target.value })}
                  className="w-24 rounded-md border bg-transparent px-2 py-1"
                  style={inputStyle}
                />
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={p.cents}
                  onChange={(e) => updatePeriod({ cents: Number(e.target.value) })}
                  className="w-20 rounded-md border bg-transparent px-2 py-1 tabular-nums"
                  style={inputStyle}
                />
                <span style={{ color: 'var(--text-muted)' }}>¢/kWh,</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={p.startHour}
                  onChange={(e) => updatePeriod({ startHour: Number(e.target.value) })}
                  className="w-14 rounded-md border bg-transparent px-1 py-1 tabular-nums"
                  style={inputStyle}
                />
                <span style={{ color: 'var(--text-muted)' }}>h →</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={p.endHour}
                  onChange={(e) => updatePeriod({ endHour: Number(e.target.value) })}
                  className="w-14 rounded-md border bg-transparent px-1 py-1 tabular-nums"
                  style={inputStyle}
                />
                <span style={{ color: 'var(--text-muted)' }}>h on</span>
                <span className="flex gap-0.5">
                  {ALL_WEEKDAYS.map((d) => (
                    <button
                      key={d}
                      onClick={() =>
                        updatePeriod({
                          weekdays: p.weekdays.includes(d)
                            ? p.weekdays.filter((x) => x !== d)
                            : [...p.weekdays, d].sort(),
                        })
                      }
                      className="h-6 w-6 rounded text-xs"
                      style={{
                        background: p.weekdays.includes(d) ? 'var(--series-1)' : 'var(--surface-1)',
                        color: p.weekdays.includes(d) ? '#fff' : 'var(--text-muted)',
                      }}
                    >
                      {WEEKDAY_LABELS[d]}
                    </button>
                  ))}
                </span>
                <button
                  onClick={() =>
                    setPlan({ ...plan, periods: plan.periods.filter((_, j) => j !== i) })
                  }
                  className="ml-auto text-xs"
                  style={{ color: 'var(--status-critical)' }}
                >
                  remove
                </button>
              </div>
            );
          })}
          <button
            onClick={() => setPlan({ ...plan, periods: [...plan.periods, newPeriod()] })}
            className="text-sm"
            style={{ color: 'var(--series-1)' }}
          >
            + add period
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => save.mutate(draft)}
          disabled={save.isPending || !currency}
          className="rounded-md px-4 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--series-1)', color: '#fff' }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {save.isSuccess && (
          <span className="text-sm" style={{ color: 'var(--status-good)' }}>
            Saved ✓
          </span>
        )}
        {save.isError && (
          <span className="text-sm" style={{ color: 'var(--status-critical)' }}>
            {(save.error as Error).message}
          </span>
        )}
      </div>
    </div>
  );
}
