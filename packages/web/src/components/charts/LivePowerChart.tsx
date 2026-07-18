import { useMemo } from 'react';
import type uPlot from 'uplot';
import type { PowerPoint } from '@sense/shared';
import { UPlotChart } from './UPlotChart.js';
import { formatWatts } from '../../lib/format.js';

const css = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#3987e5';

export function powerChartOptions(label: string): Omit<uPlot.Options, 'width' | 'height'> {
  const series1 = css('--series-1');
  const gridline = css('--gridline');
  const axis = css('--axis');
  const textMuted = css('--text-muted');
  return {
    legend: { show: false },
    cursor: { points: { show: true } },
    scales: {
      x: { time: true },
      y: { range: (_u, _min, max) => [0, Math.max(max * 1.15, 100)] },
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
        values: (_u, vals) => vals.map((v) => formatWatts(v as number)),
        size: 70,
      },
    ],
    series: [
      {},
      {
        label,
        stroke: series1,
        width: 2,
        fill: `${series1}22`,
        spanGaps: false,
        points: { show: false },
      },
    ],
  };
}

export function LivePowerChart({ series }: { series: PowerPoint[] }) {
  const data = useMemo<uPlot.AlignedData>(() => {
    const ts = series.map((p) => p.t);
    const w = series.map((p) => p.wAvg);
    return [ts, w];
  }, [series]);
  const options = useMemo(() => powerChartOptions('Power'), []);
  return <UPlotChart data={data} options={options} height={280} />;
}
