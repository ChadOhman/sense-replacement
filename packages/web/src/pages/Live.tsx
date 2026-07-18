import { useQuery } from '@tanstack/react-query';
import type { SummaryResponse } from '@sense/shared';
import { get } from '../api/client.js';
import { useLiveSocket } from '../hooks/useLiveSocket.js';
import { LivePowerChart } from '../components/charts/LivePowerChart.js';
import { DeviceCard } from '../components/DeviceCard.js';
import { StatCard } from '../components/StatCard.js';
import { Skeleton } from '../components/Skeleton.js';
import { formatKwh, formatWatts } from '../lib/format.js';

export function Live() {
  const { frame, series, stale } = useLiveSocket();
  const summary = useQuery({
    queryKey: ['summary'],
    queryFn: () => get<SummaryResponse>('/api/summary'),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6">
      <div className="card p-6 text-center">
        {frame ? (
          <>
            <div
              className="text-6xl font-bold tabular-nums transition-opacity"
              style={{ opacity: stale ? 0.35 : 1 }}
            >
              {formatWatts(frame.w)}
            </div>
            <div className="mt-2 flex justify-center gap-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {stale && (
                <span
                  className="rounded-full px-2 py-0.5 text-xs"
                  style={{ background: 'var(--surface-2)', color: 'var(--status-warning)' }}
                >
                  stale
                </span>
              )}
              <span className="tabular-nums">{frame.volts !== null ? `${frame.volts.toFixed(1)} V` : '—'}</span>
              <span className="tabular-nums">{frame.hz !== null ? `${frame.hz.toFixed(1)} Hz` : '—'}</span>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 py-6">
            <Skeleton className="h-14 w-48" />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              waiting for live data…
            </div>
          </div>
        )}
      </div>

      <div className="card p-4">
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Last hour
        </div>
        <LivePowerChart series={series} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Today" value={formatKwh(summary.data?.todayKwh)} />
        <StatCard label="This week" value={formatKwh(summary.data?.weekKwh)} />
        <StatCard label="This month" value={formatKwh(summary.data?.monthKwh)} />
        <StatCard label="Always on" value={formatWatts(summary.data?.alwaysOnW)} />
      </div>

      <div>
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          On now
        </div>
        {frame && frame.devices.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {frame.devices
              .slice()
              .sort((a, b) => b.w - a.w)
              .map((d) => (
                <DeviceCard key={d.id} id={d.id} name={d.name} icon={d.icon} watts={d.w} />
              ))}
          </div>
        ) : (
          <div className="card p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            {frame ? 'Nothing detected on right now' : 'Waiting for device data…'}
          </div>
        )}
      </div>
    </div>
  );
}
