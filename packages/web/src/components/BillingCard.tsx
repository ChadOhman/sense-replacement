import { useQuery } from '@tanstack/react-query';
import type { BillingResponse } from '@sense/shared';
import { get } from '../api/client.js';
import { formatCurrency, formatDayLabel, formatKwh } from '../lib/format.js';

export function BillingCard() {
  const billing = useQuery({
    queryKey: ['billing'],
    queryFn: () => get<BillingResponse>('/api/billing'),
    refetchInterval: 5 * 60_000,
  });
  if (!billing.data) return null;
  const b = billing.data;
  const pct = Math.min(100, (b.dayOfCycle / b.daysInCycle) * 100);
  const vsLast =
    b.forecastCost !== null && b.lastCycleCost !== null && b.lastCycleCost > 0
      ? ((b.forecastCost - b.lastCycleCost) / b.lastCycleCost) * 100
      : null;

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>
          Current bill
        </span>
        <span style={{ color: 'var(--text-muted)' }}>
          {formatDayLabel(b.cycleStartDay)} — {formatDayLabel(b.cycleEndDay)} · day {b.dayOfCycle}/
          {b.daysInCycle}
        </span>
      </div>
      <div className="mb-3 h-1.5 w-full rounded-full" style={{ background: 'var(--surface-2)' }}>
        <div
          className="h-1.5 rounded-full"
          style={{ width: `${pct}%`, background: 'var(--series-1)' }}
        />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div>
          <span className="text-2xl font-semibold tabular-nums">
            {formatCurrency(b.toDateCost, b.currency)}
          </span>
          <span className="ml-2 text-sm tabular-nums" style={{ color: 'var(--text-secondary)' }}>
            {formatKwh(b.toDateKwh)} so far
          </span>
        </div>
        {b.forecastCost !== null && (
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            on pace for{' '}
            <span className="font-medium tabular-nums" style={{ color: 'var(--text-primary)' }}>
              {formatCurrency(b.forecastCost, b.currency)}
            </span>
            {vsLast !== null && (
              <span
                className="ml-1 tabular-nums"
                style={{ color: vsLast > 5 ? 'var(--status-warning)' : 'var(--status-good)' }}
              >
                ({vsLast >= 0 ? '+' : ''}
                {vsLast.toFixed(0)}% vs last cycle)
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
