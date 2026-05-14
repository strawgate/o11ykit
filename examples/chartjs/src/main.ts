import {
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsTimeSeriesConfig,
} from "@otlpkit/adapters/chartjs";
import Chart from "chart.js/auto";

import { query } from "../../shared/store.js";

function requireCanvas(selector: string): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>(selector);
  if (!canvas) {
    throw new Error(`Expected ${selector} canvas to exist.`);
  }
  return canvas;
}

// Query the RowGroupStore via ScanEngine
const result = query();

for (const [selector, config] of [
  ["#time-series", toChartJsTimeSeriesConfig(result, { timestampUnit: "nanoseconds" })],
  ["#latest-values", toChartJsLatestValuesConfig(result, { timestampUnit: "nanoseconds" })],
  ["#histogram", toChartJsHistogramConfig(result, { timestampUnit: "nanoseconds" })],
] as const) {
  const context = requireCanvas(selector).getContext("2d");
  if (!context) {
    throw new Error(`Expected 2D rendering context for ${selector}.`);
  }
  new Chart(context, config);
}
