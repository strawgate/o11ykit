import { useRef, useEffect } from "preact/hooks";
import type { RefObject } from "preact";
import {
  Chart,
  type ChartType,
  type ChartConfiguration,
} from "chart.js";
import { getChartTheme, type ChartTheme } from "../theme.js";

export interface ChartLifecycleResult {
  canvasRef: RefObject<HTMLCanvasElement>;
  wrapperRef: RefObject<HTMLDivElement>;
}

/**
 * Shared Chart.js lifecycle hook.
 *
 * Manages canvas/wrapper refs, chart creation, updates, and cleanup.
 * The caller provides a builder function that receives the theme and
 * returns `null` (skip render) or a chart configuration.
 *
 * @param builder - Called on each effect run. Return null to destroy the chart,
 *   or return { type, data, options } to create/update it.
 * @param deps - Dependency array for the effect (same semantics as useEffect).
 */
export function useChartLifecycle<T extends ChartType>(
  builder: (theme: ChartTheme) => ChartConfiguration<T> | null,
  deps: unknown[],
): ChartLifecycleResult {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart<T> | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !wrapperRef.current) return;

    const theme = getChartTheme(wrapperRef.current);
    const config = builder(theme);

    if (!config) {
      chartRef.current?.destroy();
      chartRef.current = null;
      return;
    }

    if (chartRef.current) {
      chartRef.current.data = config.data;
      if (config.options) chartRef.current.options = config.options as never;
      chartRef.current.update();
    } else {
      chartRef.current = new Chart<T>(canvasRef.current, config);
    }

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, deps);

  return { canvasRef, wrapperRef };
}
