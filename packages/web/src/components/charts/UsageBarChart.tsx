import { useState } from 'react';
import type { UsageBucket } from '@sense/shared';
import { formatCurrency, formatKwh } from '../../lib/format.js';

interface Props {
  buckets: UsageBucket[];
  currency: string;
  labelFormatter?: (label: string) => string;
  height?: number;
}

/** Hand-rolled SVG bar chart: rounded-top bars, hover tooltip, keyboard focus. */
export function UsageBarChart({ buckets, currency, labelFormatter, height = 240 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  if (buckets.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm" style={{ height, color: 'var(--text-muted)' }}>
        No usage data yet
      </div>
    );
  }
  const max = Math.max(...buckets.map((b) => b.kwh), 0.001);
  const chartH = height - 28; // room for labels
  const fmt = labelFormatter ?? ((l: string) => l);
  const labelEvery = Math.ceil(buckets.length / 10);

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${buckets.length * 10} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="Usage bar chart"
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={0}
            x2={buckets.length * 10}
            y1={chartH - chartH * f}
            y2={chartH - chartH * f}
            stroke="var(--gridline)"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {buckets.map((b, i) => {
          const h = Math.max((b.kwh / max) * chartH, b.kwh > 0 ? 2 : 0);
          return (
            <rect
              key={b.label}
              x={i * 10 + 1}
              y={chartH - h}
              width={8}
              height={h}
              rx={1}
              fill={hover === i ? 'var(--series-2)' : 'var(--series-1)'}
              tabIndex={0}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            />
          );
        })}
      </svg>
      <div
        className="flex justify-between text-[10px] tabular-nums"
        style={{ color: 'var(--text-muted)' }}
      >
        {buckets.map((b, i) =>
          i % labelEvery === 0 ? <span key={b.label}>{fmt(b.label)}</span> : null,
        )}
      </div>
      {hover !== null && buckets[hover] && (
        <div
          className="u-tooltip"
          style={{
            left: `${((hover + 0.5) / buckets.length) * 100}%`,
            top: 0,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="font-medium">{fmt(buckets[hover].label)}</div>
          <div>
            {formatKwh(buckets[hover].kwh)} · {formatCurrency(buckets[hover].cost, currency)}
          </div>
        </div>
      )}
    </div>
  );
}
