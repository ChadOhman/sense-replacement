import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { NeutralEventsResponse, StatusResponse, SummaryResponse } from '@sense/shared';
import { get } from '../api/client.js';
import { useLiveSocket } from '../hooks/useLiveSocket.js';
import { LivePowerChart } from '../components/charts/LivePowerChart.js';
import { DeviceCard } from '../components/DeviceCard.js';
import { StatCard } from '../components/StatCard.js';
import { Skeleton } from '../components/Skeleton.js';
import { formatCurrency, formatKwh, formatRateCents, formatRelativeTime, formatWatts } from '../lib/format.js';

const SAG_CHIP_THRESHOLD = 108; // visual warning tint on a leg chip

/** What the current draw costs per hour if it held steady, at the rate in
 *  effect right now. Solar-equipped homes are billed on net, so that's what we
 *  cost — a net-negative hour is a credit, not a negative bill. */
function CostRate({
  watts,
  rateCents,
  periodName,
  currency,
}: {
  watts: number;
  rateCents: number;
  periodName: string | null;
  currency: string;
}) {
  const perHour = (watts / 1000) * (rateCents / 100);
  let label: string;
  if (perHour < 0) label = `${formatCurrency(-perHour, currency)}/hr credit`;
  else if (perHour > 0 && perHour < 0.005) label = `< ${formatCurrency(0.01, currency)}/hr`;
  else label = `${formatCurrency(perHour, currency)}/hr`;

  return (
    <div className="mt-2 text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
      ≈ <span style={{ color: 'var(--text-secondary)' }}>{label}</span> ·{' '}
      {formatRateCents(rateCents, currency)}/kWh
      {periodName && ` (${periodName})`}
    </div>
  );
}

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
  const neutralEvents = useQuery({
    queryKey: ['neutral-events'],
    queryFn: () => get<NeutralEventsResponse>('/api/neutral-events'),
    refetchInterval: 30_000,
  });
  const brownout = status.data?.activeBrownout ?? null;
  const neutralEpisode = status.data?.activeNeutralEpisode ?? null;
  const stall = status.data?.activeStall ?? null;
  const neutralHealth = neutralEvents.data?.health ?? null;
  const currency = summary.data?.currency ?? 'USD';

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
      {neutralEpisode && (
        <div
          className="rounded-md px-4 py-3 text-sm font-medium"
          style={{ background: 'var(--status-critical)', color: '#fff' }}
        >
          ⚠️ Voltage legs diverging — spread of{' '}
          <span className="tabular-nums">{neutralEpisode.maxSpreadVolts.toFixed(1)} V</span> between
          legs, started {formatRelativeTime(neutralEpisode.startedTs)}. Repeated divergence can
          indicate a floating neutral.
        </div>
      )}
      {stall && (
        <div
          className="rounded-md px-4 py-3 text-sm font-medium"
          style={{ background: 'var(--status-critical)', color: '#fff' }}
        >
          ⚠️ Motor stall in progress — {stall.spikeCount} failed start attempts of ~
          <span className="tabular-nums">{Math.round(stall.avgSpikeW)} W</span> since{' '}
          {formatRelativeTime(stall.startedTs)}. Often an AC compressor; repeated stalling causes
          damage.
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
              {frame.solarW !== null && (
                <span
                  className="rounded-full px-2 py-0.5 tabular-nums"
                  style={{ background: 'var(--surface-2)', color: 'var(--series-4)' }}
                >
                  ☀️ {formatWatts(frame.solarW)}
                  {frame.solarW > 1 && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' '}
                      · net {formatWatts(frame.w - frame.solarW)}
                    </span>
                  )}
                </span>
              )}
              {frame.voltageLegs.length > 0 ? (
                frame.voltageLegs.map((v, i) => <VoltageChip key={i} volts={v} />)
              ) : (
                <span className="tabular-nums">{frame.volts !== null ? `${frame.volts.toFixed(1)} V` : '—'}</span>
              )}
              <span className="tabular-nums">{frame.hz !== null ? `${frame.hz.toFixed(1)} Hz` : '—'}</span>
            </div>
            {summary.data && (
              <CostRate
                watts={frame.solarW !== null ? frame.w - frame.solarW : frame.w}
                rateCents={summary.data.rateCentsPerKwh}
                periodName={summary.data.ratePeriodName}
                currency={currency}
              />
            )}
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
        <StatCard
          label="Today"
          value={formatKwh(summary.data?.todayKwh)}
          sub={summary.data && formatCurrency(summary.data.todayCost, currency)}
        />
        <StatCard
          label="This week"
          value={formatKwh(summary.data?.weekKwh)}
          sub={summary.data && formatCurrency(summary.data.weekCost, currency)}
        />
        <StatCard
          label="This month"
          value={formatKwh(summary.data?.monthKwh)}
          sub={summary.data && formatCurrency(summary.data.monthCost, currency)}
        />
        {summary.data?.solarTodayKwh !== null && summary.data?.solarTodayKwh !== undefined ? (
          <StatCard
            label="Solar today"
            value={
              <span style={{ color: 'var(--series-4)' }}>{formatKwh(summary.data.solarTodayKwh)}</span>
            }
          />
        ) : null}
        {frame?.nilm?.unknownW != null && (
          <StatCard
            label="Unknown power"
            value={formatWatts(frame.nilm.unknownW)}
            sub={<span>not matched to any device</span>}
          />
        )}
        <StatCard
          label="Always on"
          value={formatWatts(summary.data?.alwaysOnW)}
          sub={
            summary.data?.alwaysOnCreep ? (
              <span style={{ color: 'var(--status-warning)' }}>
                ↑{Math.round(summary.data.alwaysOnCreep.pct * 100)}% vs baseline{' '}
                {formatWatts(summary.data.alwaysOnCreep.baselineW)}
              </span>
            ) : undefined
          }
        />
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
        {neutralHealth && (
          <div
            className="mb-3 flex items-start justify-between gap-3 rounded-md px-3 py-2 text-sm"
            style={{ background: 'var(--surface-2)' }}
          >
            <span>
              <span className="mr-2 font-medium">Neutral health</span>
              {neutralHealth.state === 'ok' && (
                <span style={{ color: 'var(--status-good)' }}>✓ legs balanced — no divergence in 7 days</span>
              )}
              {neutralHealth.state === 'suspect' && (
                <span style={{ color: 'var(--status-warning)' }}>
                  {neutralHealth.events7d} divergence episode{neutralHealth.events7d === 1 ? '' : 's'} this week
                  (max spread <span className="tabular-nums">{(neutralHealth.maxSpread7dVolts ?? 0).toFixed(1)} V</span>)
                  — worth keeping an eye on
                </span>
              )}
              {neutralHealth.state === 'alert' && (
                <span style={{ color: 'var(--status-critical)' }}>
                  possible floating neutral — {neutralHealth.events7d} episode{neutralHealth.events7d === 1 ? '' : 's'} this
                  week, max spread <span className="tabular-nums">{(neutralHealth.maxSpread7dVolts ?? 0).toFixed(1)} V</span>.
                  Contact an electrician.
                </span>
              )}
            </span>
          </div>
        )}
        <Link to="/power-quality" className="text-sm" style={{ color: 'var(--series-1)' }}>
          View power quality →
        </Link>
      </div>
    </div>
  );
}
