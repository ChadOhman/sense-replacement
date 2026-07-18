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
  const optionsRef = useRef(options);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = new uPlot(
      { ...optionsRef.current, width: el.clientWidth || 600, height },
      data,
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
  }, [height]);

  useEffect(() => {
    chartRef.current?.setData(data);
  }, [data]);

  return <div ref={containerRef} className="w-full" />;
}
