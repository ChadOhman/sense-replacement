import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DeviceDetailResponse, SettingsResponse } from '@sense/shared';
import { get } from '../api/client.js';
import { DeviceIcon } from '../components/DeviceIcon.js';
import { UsageBarChart } from '../components/charts/UsageBarChart.js';
import { SkeletonRows } from '../components/Skeleton.js';
import { formatDayLabel, formatRelativeTime, formatWatts } from '../lib/format.js';

export function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const detail = useQuery({
    queryKey: ['device', id],
    queryFn: () => get<DeviceDetailResponse>(`/api/devices/${id}`),
    enabled: !!id,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => get<SettingsResponse>('/api/settings'),
  });
  const currency = settings.data?.currency ?? 'USD';

  if (detail.isLoading) return <SkeletonRows rows={6} />;
  if (detail.isError || !detail.data) {
    return (
      <div className="card p-8 text-center">
        <div style={{ color: 'var(--text-muted)' }}>Device not found.</div>
        <Link to="/devices" className="mt-2 inline-block text-sm underline">
          Back to devices
        </Link>
      </div>
    );
  }
  const { device, nowW, daily, monthly, events } = detail.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <DeviceIcon icon={device.icon} className="text-4xl" />
        <div>
          <h1 className="text-xl font-semibold">
            {device.name}
            {device.revoked && (
              <span className="ml-2 text-sm font-normal" style={{ color: 'var(--text-muted)' }}>
                (removed by Sense)
              </span>
            )}
          </h1>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {device.type ?? 'Unknown type'} · now{' '}
            <span className="tabular-nums" style={{ color: nowW ? 'var(--series-3)' : undefined }}>
              {formatWatts(nowW)}
            </span>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Last 30 days
        </div>
        <UsageBarChart
          buckets={daily.map((d) => ({ label: d.day, kwh: d.kwh, cost: d.cost }))}
          currency={currency}
          labelFormatter={formatDayLabel}
        />
      </div>

      <div className="card p-4">
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Last 12 months
        </div>
        <UsageBarChart
          buckets={monthly.map((m) => ({ label: m.month, kwh: m.kwh, cost: m.cost }))}
          currency={currency}
        />
      </div>

      <div className="card p-4">
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Recent activity
        </div>
        {events.length === 0 ? (
          <div className="py-4 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No on/off events recorded yet.
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span
                    className="mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{
                      background: 'var(--surface-2)',
                      color: e.type === 'on' ? 'var(--status-good)' : 'var(--text-muted)',
                    }}
                  >
                    {e.type.toUpperCase()}
                  </span>
                  {e.watts !== null && <span className="tabular-nums">{formatWatts(e.watts)}</span>}
                </span>
                <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {formatRelativeTime(e.ts)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
