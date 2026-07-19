import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PowerHistoryResponse, SettingsResponse, UsageResponse, UsageScale } from '@sense/shared';
import { get } from '../api/client.js';
import { PageHeader } from '../components/PageHeader.js';
import { BillingCard } from '../components/BillingCard.js';
import { StatCard } from '../components/StatCard.js';
import { UsageBarChart } from '../components/charts/UsageBarChart.js';
import { UPlotChart } from '../components/charts/UPlotChart.js';
import { powerChartOptions } from '../components/charts/LivePowerChart.js';
import { SkeletonRows } from '../components/Skeleton.js';
import { DeviceIcon } from '../components/DeviceIcon.js';
import { formatCurrency, formatDayLabel, formatKwh } from '../lib/format.js';

const SCALES: UsageScale[] = ['day', 'week', 'month', 'year'];

export function Trends() {
  const [scale, setScale] = useState<UsageScale>('day');
  const [compare, setCompare] = useState(false);
  const usage = useQuery({
    queryKey: ['usage', scale, compare],
    queryFn: () =>
      get<UsageResponse>(`/api/history/usage?scale=${scale}${compare ? '&compare=1' : ''}`),
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => get<SettingsResponse>('/api/settings'),
  });
  const currency = settings.data?.currency ?? 'USD';

  const midnight = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }, []);
  const todayPower = useQuery({
    queryKey: ['power', 'today'],
    queryFn: () =>
      get<PowerHistoryResponse>(
        `/api/history/power?from=${midnight}&to=${Math.floor(Date.now() / 1000)}`,
      ),
    enabled: scale === 'day',
    refetchInterval: 60_000,
  });
  const powerData = useMemo(() => {
    const points = todayPower.data?.points ?? [];
    return [points.map((p) => p.t), points.map((p) => p.wAvg)] as [number[], number[]];
  }, [todayPower.data]);
  const powerOptions = useMemo(() => powerChartOptions('Power'), []);

  const total = usage.data?.totalKwh ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trends"
        actions={
          <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--surface-2)' }}>
            {SCALES.map((s) => (
              <button
                key={s}
                onClick={() => setScale(s)}
                className="rounded-md px-3 py-1 text-sm capitalize transition-colors"
                style={{
                  background: scale === s ? 'var(--series-1)' : 'transparent',
                  color: scale === s ? '#fff' : 'var(--text-secondary)',
                }}
              >
                {s}
              </button>
            ))}
          </div>
        }
      />

      <BillingCard />

      <div className={`grid gap-3 ${usage.data?.totalProductionKwh !== undefined ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <StatCard label="Total usage" value={formatKwh(usage.data?.totalKwh)} />
        <StatCard label="Estimated cost" value={formatCurrency(usage.data?.totalCost, currency)} />
        {usage.data?.totalProductionKwh !== undefined && (
          <StatCard
            label="Solar production"
            value={
              <span style={{ color: 'var(--series-4)' }}>
                {formatKwh(usage.data.totalProductionKwh)}
              </span>
            }
          />
        )}
      </div>

      {scale === 'day' && (
        <div className="card p-4">
          <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            Today's power
          </div>
          {(todayPower.data?.points.length ?? 0) > 0 ? (
            <UPlotChart data={powerData} options={powerOptions} height={220} />
          ) : (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No measurements yet today.
            </div>
          )}
        </div>
      )}

      <div className="card p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            Usage by {scale}
          </div>
          <button
            onClick={() => setCompare(!compare)}
            className="rounded-full px-3 py-0.5 text-xs transition-colors"
            style={{
              background: compare ? 'var(--series-1)' : 'var(--surface-2)',
              color: compare ? '#fff' : 'var(--text-muted)',
            }}
          >
            vs last year
          </button>
        </div>
        {usage.isLoading ? (
          <SkeletonRows rows={3} />
        ) : (
          <UsageBarChart
            buckets={usage.data?.buckets ?? []}
            compare={compare ? (usage.data?.compare ?? []) : undefined}
            currency={currency}
            labelFormatter={scale === 'day' || scale === 'week' ? formatDayLabel : undefined}
          />
        )}
      </div>

      <div className="card p-4">
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          By device
        </div>
        {(usage.data?.devices.length ?? 0) === 0 ? (
          <div className="py-4 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No per-device data for this range yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {usage.data!.devices.map((d) => (
              <li key={d.deviceId} className="text-sm">
                <div className="flex items-center justify-between">
                  <span>
                    <DeviceIcon icon={d.icon} className="mr-2" />
                    {d.name}
                  </span>
                  <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {formatKwh(d.kwh)} · {formatCurrency(d.cost, currency)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full rounded-full" style={{ background: 'var(--surface-2)' }}>
                  <div
                    className="h-1.5 rounded-full"
                    style={{
                      width: `${total > 0 ? Math.min((d.kwh / total) * 100, 100) : 0}%`,
                      background: 'var(--series-1)',
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
