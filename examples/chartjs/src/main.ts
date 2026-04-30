import {
  toChartJsViewHistogramConfig,
  toChartJsViewLatestValuesConfig,
  toChartJsViewLineConfig,
} from "@otlpkit/adapters/chartjs";
import { buildHistogramFrame, buildLatestValuesFrame, buildTimeSeriesFrame } from "@otlpkit/views";
import Chart from "chart.js/auto";

import { sampleMetricsDocument } from "../../shared/sample.js";

function requireCanvas(selector: string): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>(selector);
  if (!canvas) {
    throw new Error(`Expected ${selector} canvas to exist.`);
  }
  return canvas;
}

const timeSeriesFrame = buildTimeSeriesFrame(sampleMetricsDocument, {
  metricName: "logfwd.inflight_batches",
  intervalMs: 1000,
  splitBy: "output",
  title: "Inflight batches by output",
});
const latestValuesFrame = buildLatestValuesFrame(sampleMetricsDocument, {
  metricName: "logfwd.inflight_batches",
  splitBy: "output",
  title: "Latest inflight batches by output",
});
const histogramFrame = buildHistogramFrame(sampleMetricsDocument, {
  metricName: "logfwd.output.duration",
  title: "Output duration histogram",
  binCount: 6,
});

for (const [selector, config] of [
  ["#time-series", toChartJsViewLineConfig(timeSeriesFrame)],
  ["#latest-values", toChartJsViewLatestValuesConfig(latestValuesFrame)],
  ["#histogram", toChartJsViewHistogramConfig(histogramFrame)],
] as const) {
  const context = requireCanvas(selector).getContext("2d");
  if (!context) {
    throw new Error(`Expected 2D rendering context for ${selector}.`);
  }
  new Chart(context, config);
}
