import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

interface Props {
  data: uPlot.AlignedData;
  options: Omit<uPlot.Options, 'width' | 'height'>;
  height?: number;
}

export function UPlotChart({ data, options, height = 260 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  // Recreated when options identity changes (callers memoize options, so this
  // fires only on real config changes like a series appearing).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = new uPlot(
      { ...options, width: el.clientWidth || 600, height },
      dataRef.current,
      el,
    );
    chartRef.current = chart;
    const ro = new ResizeObserver(() => {
      chart.setSize({ width: el.clientWidth || 600, height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.destroy();
      chartRef.current = null;
    };
  }, [height, options]);

  useEffect(() => {
    chartRef.current?.setData(data);
  }, [data]);

  return <div ref={containerRef} className="w-full" />;
}
