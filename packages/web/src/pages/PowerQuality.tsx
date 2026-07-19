import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type uPlot from 'uplot';
import type {
  NeutralEventsResponse,
  VoltageEventsResponse,
  VoltageHistoryResponse,
  VoltageSummaryResponse,
} from '@sense/shared';
import { get } from '../api/client.js';
import { PageHeader } from '../components/PageHeader.js';
import { UPlotChart } from '../components/charts/UPlotChart.js';
import { Skeleton, SkeletonRows } from '../components/Skeleton.js';
import { formatRelativeTime } from '../lib/format.js';

const DAY_SECONDS = 86400;
const FALLBACK_BAND = { min: 114, max: 126 };

const css = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#3987e5';

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const int = parseInt(full, 16);
  if (Number.isNaN(int)) return `rgba(57, 135, 229, ${alpha})`;
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatVolts(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(1)} V`;
}

function formatWindowLabel(fromSec: number, toSec: number): string {
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  const fromStr = new Date(fromSec * 1000).toLocaleString(undefined, opts);
  const toStr = new Date(toSec * 1000).toLocaleString(undefined, opts);
  return `${fromStr} — ${toStr}`;
}

function voltageChartOptions(
  band: { min: number; max: number },
  window: { from: number; to: number },
): Omit<uPlot.Options, 'width' | 'height'> {
  const series1 = css('--series-1');
  const series8 = css('--series-8');
  const gridline = css('--gridline');
  const axis = css('--axis');
  const textMuted = css('--text-muted');
  const bandColor = hexToRgba(series1, 0.08);
  return {
    legend: { show: false },
    cursor: { points: { show: false } },
    scales: {
      // Pin the x-domain to the 24h window so sparse data doesn't auto-range.
      x: { time: true, range: () => [window.from, window.to] },
      y: {
        range: (_u, dataMin, dataMax) => {
          const lo = Number.isFinite(dataMin as number) ? Math.min(dataMin as number, 105) : 105;
          const hi = Number.isFinite(dataMax as number) ? Math.max(dataMax as number, 135) : 135;
          return [lo, hi];
        },
      },
    },
    axes: [
      {
        stroke: textMuted,
        grid: { stroke: gridline, width: 1 },
        ticks: { stroke: axis, width: 1 },
      },
      {
        stroke: textMuted,
        grid: { stroke: gridline, width: 1 },
        ticks: { stroke: axis, width: 1 },
        values: (_u, vals) => vals.map((v) => `${(v as number).toFixed(0)} V`),
        size: 60,
      },
    ],
    series: [
      {},
      { label: 'L1', stroke: series1, width: 1.5, points: { show: false } },
      { label: 'L2', stroke: series8, width: 1.5, points: { show: false } },
    ],
    hooks: {
      drawClear: [
        (u) => {
          const { ctx } = u;
          const { top, left, width, height } = u.bbox;
          const yTop = u.valToPos(band.max, 'y', true);
          const yBottom = u.valToPos(band.min, 'y', true);
          const rectTop = Math.max(top, Math.min(yTop, yBottom));
          const rectBottom = Math.min(top + height, Math.max(yTop, yBottom));
          if (rectBottom > rectTop) {
            ctx.save();
            ctx.fillStyle = bandColor;
            ctx.fillRect(left, rectTop, width, rectBottom - rectTop);
            ctx.restore();
          }
        },
      ],
    },
  };
}

export function PowerQuality() {
  const [windowOffset, setWindowOffset] = useState(0);

  const { from, to } = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowTo = nowSec - windowOffset * DAY_SECONDS;
    return { from: windowTo - DAY_SECONDS, to: windowTo };
  }, [windowOffset]);

  const history = useQuery({
    queryKey: ['voltage-history', from, to],
    queryFn: () => get<VoltageHistoryResponse>(`/api/voltage-history?from=${from}&to=${to}`),
  });
  const summary = useQuery({
    queryKey: ['voltage-summary'],
    queryFn: () => get<VoltageSummaryResponse>('/api/voltage-summary'),
    refetchInterval: 60_000,
  });
  const voltageEvents = useQuery({
    queryKey: ['voltage-events'],
    queryFn: () => get<VoltageEventsResponse>('/api/voltage-events'),
    refetchInterval: 30_000,
  });
  const neutralEvents = useQuery({
    queryKey: ['neutral-events'],
    queryFn: () => get<NeutralEventsResponse>('/api/neutral-events'),
    refetchInterval: 30_000,
  });

  const legs = history.data?.legs ?? [];
  const l1 = legs[0] ?? [];
  const l2 = legs[1] ?? [];
  const hasPoints = l1.length > 0 || l2.length > 0;
  const previousDisabled = history.isSuccess && !hasPoints;

  const chartData = useMemo<uPlot.AlignedData>(() => {
    const tSet = new Set<number>();
    l1.forEach((p) => tSet.add(p.t));
    l2.forEach((p) => tSet.add(p.t));
    const ts = Array.from(tSet).sort((a, b) => a - b);
    const l1Map = new Map(l1.map((p) => [p.t, p.vAvg]));
    const l2Map = new Map(l2.map((p) => [p.t, p.vAvg]));
    return [ts, ts.map((t) => l1Map.get(t) ?? null), ts.map((t) => l2Map.get(t) ?? null)];
  }, [history.data]);

  const nominal = summary.data?.nominalVolts;
  const band = useMemo(
    () => (nominal ? { min: nominal * 0.95, max: nominal * 1.05 } : FALLBACK_BAND),
    [nominal],
  );
  const chartOptions = useMemo(
    () => voltageChartOptions(band, { from, to }),
    [band, from, to],
  );

  const nowVolts = summary.data?.nowVolts ?? [];
  const summaryLegs = summary.data?.legs ?? [];
  const dips30d = summary.data?.dips30d ?? 0;
  const spikes30d = summary.data?.spikes30d ?? 0;
  const recent = summary.data?.recent ?? [];

  const neutralHealth = neutralEvents.data?.health ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title="Power Quality" />

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium tabular-nums" style={{ color: 'var(--text-secondary)' }}>
            {formatWindowLabel(from, to)}
          </div>
          <div className="flex gap-2 text-sm">
            <button
              onClick={() => setWindowOffset((o) => o + 1)}
              disabled={previousDisabled}
              className="rounded-md px-3 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              ← previous
            </button>
            <button
              onClick={() => setWindowOffset((o) => Math.max(0, o - 1))}
              disabled={windowOffset === 0}
              className="rounded-md px-3 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
            >
              next →
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_220px]">
          <div>
            {history.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : hasPoints ? (
              <UPlotChart data={chartData} options={chartOptions} height={260} />
            ) : (
              <div
                className="flex h-64 items-center justify-center text-sm"
                style={{ color: 'var(--text-muted)' }}
              >
                No voltage data for this window.
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Voltage now
              </div>
              <div className="mt-1 flex gap-4 text-lg font-semibold tabular-nums">
                <span style={{ color: 'var(--series-1)' }}>L1 {formatVolts(nowVolts[0])}</span>
                <span style={{ color: 'var(--series-8)' }}>L2 {formatVolts(nowVolts[1])}</span>
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Last 24 hours
              </div>
              <table className="mt-1 w-full text-sm tabular-nums">
                <thead>
                  <tr style={{ color: 'var(--text-muted)' }}>
                    <th className="text-left font-normal"></th>
                    <th className="text-right font-normal" style={{ color: 'var(--series-1)' }}>
                      L1
                    </th>
                    <th className="text-right font-normal" style={{ color: 'var(--series-8)' }}>
                      L2
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="py-0.5">Average</td>
                    <td className="py-0.5 text-right">{formatVolts(summaryLegs[0]?.avg)}</td>
                    <td className="py-0.5 text-right">{formatVolts(summaryLegs[1]?.avg)}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5">Min sustained</td>
                    <td className="py-0.5 text-right">{formatVolts(summaryLegs[0]?.minSustained)}</td>
                    <td className="py-0.5 text-right">{formatVolts(summaryLegs[1]?.minSustained)}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5">Max sustained</td>
                    <td className="py-0.5 text-right">{formatVolts(summaryLegs[0]?.maxSustained)}</td>
                    <td className="py-0.5 text-right">{formatVolts(summaryLegs[1]?.maxSustained)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Voltage dips & spikes
        </div>
        {summary.isLoading ? (
          <SkeletonRows rows={3} />
        ) : (
          <>
            {dips30d === 0 && spikes30d === 0 ? (
              <div className="py-2 text-sm" style={{ color: 'var(--status-good)' }}>
                ✓ No dips or spikes this month
              </div>
            ) : (
              <div className="py-2 text-sm" style={{ color: 'var(--status-warning)' }}>
                {dips30d} dip{dips30d === 1 ? '' : 's'} · {spikes30d} spike{spikes30d === 1 ? '' : 's'} in the
                last 30 days
              </div>
            )}
            {recent.length > 0 && (
              <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {recent.map((r, i) => (
                  <li key={i} className="flex items-center justify-between py-2 text-sm">
                    <span>
                      <span
                        className="mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium"
                        style={{
                          background: 'var(--surface-2)',
                          color: r.kind === 'dip' ? 'var(--status-warning)' : 'var(--status-critical)',
                        }}
                      >
                        {r.kind.toUpperCase()}
                      </span>
                      L{r.leg + 1} · <span className="tabular-nums">{r.volts.toFixed(1)} V</span>
                    </span>
                    <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {formatRelativeTime(r.t)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="card p-4">
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Events
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
        {(voltageEvents.data?.events.length ?? 0) === 0 &&
        (neutralEvents.data?.events.length ?? 0) === 0 ? (
          <div className="py-3 text-center text-sm" style={{ color: 'var(--status-good)' }}>
            ✓ No brownouts or leg divergence in the last 30 days
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {[
              ...(voltageEvents.data?.events ?? []).map((e) => ({
                key: `v${e.id}`,
                startedTs: e.startedTs,
                endedTs: e.endedTs,
                label: e.endedTs === null ? 'ACTIVE' : 'BROWNOUT',
                detail: (
                  <>
                    leg {e.leg + 1} · min <span className="tabular-nums">{e.minVolts.toFixed(1)} V</span>
                  </>
                ),
              })),
              ...(neutralEvents.data?.events ?? []).map((e) => ({
                key: `n${e.id}`,
                startedTs: e.startedTs,
                endedTs: e.endedTs,
                label: e.endedTs === null ? 'ACTIVE' : 'DIVERGENCE',
                detail: (
                  <>
                    legs split{' '}
                    <span className="tabular-nums">
                      {e.peakHighVolts.toFixed(1)}/{e.peakLowVolts.toFixed(1)} V
                    </span>{' '}
                    · spread <span className="tabular-nums">{e.maxSpreadVolts.toFixed(1)} V</span>
                  </>
                ),
              })),
            ]
              .sort((a, b) => b.startedTs - a.startedTs)
              .slice(0, 10)
              .map((e) => (
                <li key={e.key} className="flex items-center justify-between py-2 text-sm">
                  <span>
                    <span
                      className="mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium"
                      style={{
                        background: 'var(--surface-2)',
                        color: e.endedTs === null ? 'var(--status-critical)' : 'var(--status-warning)',
                      }}
                    >
                      {e.label}
                    </span>
                    {e.detail}
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
