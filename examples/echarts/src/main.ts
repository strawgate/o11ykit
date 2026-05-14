import {
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
} from "@otlpkit/adapters/echarts";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import { query } from "../../shared/store.js";

use([CanvasRenderer, GridComponent, LegendComponent, LineChart, BarChart, TooltipComponent]);

function requireContainer(selector: string): HTMLDivElement {
  const container = document.querySelector<HTMLDivElement>(selector);
  if (!container) {
    throw new Error(`Expected ${selector} container to exist.`);
  }
  return container;
}

// Query the RowGroupStore via ScanEngine
const result = query();

for (const [selector, option] of [
  ["#time-series", toEChartsTimeSeriesOption(result, { timestampUnit: "nanoseconds" })],
  ["#latest-values", toEChartsLatestValuesOption(result, { timestampUnit: "nanoseconds" })],
  ["#histogram", toEChartsHistogramOption(result, { timestampUnit: "nanoseconds" })],
] as const) {
  init(requireContainer(selector)).setOption(option);
}
