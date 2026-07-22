import { useMemo } from 'react';
import type uPlot from 'uplot';
import { UPlotChart } from './UPlotChart.js';
import { formatWatts } from '../../lib/format.js';

const css = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#3987e5';

/** Tiny sparkline of a NILM event/cluster waveform: per-second watt deltas
 *  over the capture window. */
export function WaveformChart({ waveform, height = 90 }: { waveform: number[]; height?: number }) {
  const data = useMemo<uPlot.AlignedData>(
    () => [waveform.map((_, i) => i), waveform],
    [waveform],
  );
  const options = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(() => {
    const stroke = css('--series-1');
    const gridline = css('--gridline');
    const textMuted = css('--text-muted');
    return {
      legend: { show: false },
      cursor: { show: false },
      scales: { x: { time: false } },
      axes: [
        { show: false },
        {
          stroke: textMuted,
          grid: { stroke: gridline, width: 1 },
          ticks: { show: false },
          values: (_u, vals) => vals.map((v) => formatWatts(v as number)),
          size: 55,
        },
      ],
      series: [
        {},
        { stroke, width: 1.5, fill: `${stroke}18`, points: { show: false } },
      ],
    };
  }, []);
  return <UPlotChart data={data} options={options} height={height} />;
}
