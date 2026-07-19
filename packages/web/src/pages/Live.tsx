import { useQuery } from '@tanstack/react-query';
import type { StatusResponse, SummaryResponse, VoltageEventsResponse } from '@sense/shared';
import { get } from '../api/client.js';
import { useLiveSocket } from '../hooks/useLiveSocket.js';
import { LivePowerChart } from '../components/charts/LivePowerChart.js';
import { DeviceCard } from '../components/DeviceCard.js';
import { StatCard } from '../components/StatCard.js';
import { Skeleton } from '../components/Skeleton.js';
import { formatKwh, formatRelativeTime, formatWatts } from '../lib/format.js';

const SAG_CHIP_THRESHOLD = 108; // visual warning tint on a leg chip

function VoltageChip({ volts }: { volts: number }) {
  const low = volts < SAG_CHIP_THRESHOLD;
  return (
    <span
      className="rounded-full px-2 py-0.5 tabular-nums"
      style={{
        background: low ? 'var(--status-critical)' : 'var(--surface-2)',
        color: low ? '#fff' : 'var(--text-secondary)',
      }}
    >
      {volts.toFixed(1)} V
    </span>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function Live() {
  const { frame, series, stale } = useLiveSocket();
  const summary = useQuery({
    queryKey: ['summary'],
    queryFn: () => get<SummaryResponse>('/api/summary'),
    refetchInterval: 60_000,
  });
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => get<StatusResponse>('/api/status'),
    refetchInterval: 5000,
  });
  const voltageEvents = useQuery({
    queryKey: ['voltage-events'],
    queryFn: () => get<VoltageEventsResponse>('/api/voltage-events'),
    refetchInterval: 30_000,
  });
  const brownout = status.data?.activeBrownout ?? null;

  return (
    <div className="space-y-6">
      {brownout && (
        <div
          className="rounded-md px-4 py-3 text-sm font-medium"
          style={{ background: 'var(--status-critical)', color: '#fff' }}
        >
          ⚠️ Brownout in progress — leg {brownout.leg + 1} down to{' '}
          <span className="tabular-nums">{brownout.minVolts.toFixed(1)} V</span> (nominal{' '}
          <span className="tabular-nums">{brownout.nominalVolts.toFixed(0)} V</span>), started{' '}
          {formatRelativeTime(brownout.startedTs)}
        </div>
      )}
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
              {frame.voltageLegs.length > 0 ? (
                frame.voltageLegs.map((v, i) => <VoltageChip key={i} volts={v} />)
              ) : (
                <span className="tabular-nums">{frame.volts !== null ? `${frame.volts.toFixed(1)} V` : '—'}</span>
              )}
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

      <div className="card p-4">
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Power quality
        </div>
        {(voltageEvents.data?.events.length ?? 0) === 0 ? (
          <div className="py-3 text-center text-sm" style={{ color: 'var(--status-good)' }}>
            ✓ No brownouts in the last 30 days
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {voltageEvents.data!.events.slice(0, 10).map((e) => (
              <li key={e.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span
                    className="mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{
                      background: 'var(--surface-2)',
                      color: e.endedTs === null ? 'var(--status-critical)' : 'var(--status-warning)',
                    }}
                  >
                    {e.endedTs === null ? 'ACTIVE' : 'BROWNOUT'}
                  </span>
                  leg {e.leg + 1} · min <span className="tabular-nums">{e.minVolts.toFixed(1)} V</span>
                  {e.endedTs !== null && e.endedTs > e.startedTs && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' '}
                      · {formatDuration(e.endedTs - e.startedTs)}
                    </span>
                  )}
                </span>
                <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {formatRelativeTime(e.startedTs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
