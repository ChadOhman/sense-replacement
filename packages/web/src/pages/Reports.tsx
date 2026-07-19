import { useQuery } from '@tanstack/react-query';
import type { ReportsResponse } from '@sense/shared';
import { get } from '../api/client.js';
import { PageHeader } from '../components/PageHeader.js';
import { DeviceIcon } from '../components/DeviceIcon.js';
import { formatCurrency, formatDayLabel, formatKwh } from '../lib/format.js';

export function Reports() {
  const reports = useQuery({
    queryKey: ['reports'],
    queryFn: () => get<ReportsResponse>('/api/reports'),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" />
      {(reports.data?.reports.length ?? 0) === 0 ? (
        <div className="card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          No cycle reports yet — one is generated automatically each time a billing cycle closes.
        </div>
      ) : (
        reports.data!.reports.map((r) => {
          const vsPrev =
            r.prevCycleCost !== null && r.prevCycleCost > 0
              ? ((r.totalCost - r.prevCycleCost) / r.prevCycleCost) * 100
              : null;
          return (
            <div key={r.period} className="card space-y-3 p-4">
              <div className="flex items-baseline justify-between">
                <div className="font-medium">
                  {formatDayLabel(r.period)} — {formatDayLabel(r.periodEnd)}
                </div>
                <div className="text-xl font-semibold tabular-nums">
                  {formatCurrency(r.totalCost, r.currency)}
                  <span className="ml-2 text-sm font-normal" style={{ color: 'var(--text-secondary)' }}>
                    {formatKwh(r.totalKwh)}
                  </span>
                  {vsPrev !== null && (
                    <span
                      className="ml-2 text-sm font-normal tabular-nums"
                      style={{ color: vsPrev > 5 ? 'var(--status-warning)' : 'var(--status-good)' }}
                    >
                      {vsPrev >= 0 ? '+' : ''}
                      {vsPrev.toFixed(0)}%
                    </span>
                  )}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Top devices
                  </div>
                  <ul className="space-y-1 text-sm">
                    {r.topDevices.map((d) => (
                      <li key={d.name} className="flex justify-between">
                        <span>{d.name}</span>
                        <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                          {formatKwh(d.kwh)} · {formatCurrency(d.cost, r.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Power quality
                  </div>
                  <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {r.powerQuality.brownouts} brownouts · {r.powerQuality.divergences} divergences ·{' '}
                    {r.powerQuality.stalls} stalls · {r.powerQuality.outages} outages
                  </div>
                  {r.anomalies.length > 0 && (
                    <>
                      <div
                        className="mb-1 mt-2 text-xs uppercase tracking-wide"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Anomalies
                      </div>
                      <ul className="space-y-0.5 text-sm">
                        {r.anomalies.map((a) => (
                          <li key={a.name} style={{ color: 'var(--status-warning)' }}>
                            <DeviceIcon icon={null} className="mr-1" />
                            {a.name} {a.direction === 'up' ? '↑' : '↓'}
                            {Math.round(Math.abs(a.pct) * 100)}%
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
