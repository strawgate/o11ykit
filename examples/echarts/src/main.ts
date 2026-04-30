import {
  toEChartsViewHistogramOption,
  toEChartsViewLatestValuesOption,
  toEChartsViewTimeSeriesOption,
} from "@otlpkit/adapters/echarts";
import { buildHistogramFrame, buildLatestValuesFrame, buildTimeSeriesFrame } from "@otlpkit/views";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import { sampleMetricsDocument } from "../../shared/sample.js";

use([CanvasRenderer, GridComponent, LegendComponent, LineChart, BarChart, TooltipComponent]);

function requireContainer(selector: string): HTMLDivElement {
  const container = document.querySelector<HTMLDivElement>(selector);
  if (!container) {
    throw new Error(`Expected ${selector} container to exist.`);
  }
  return container;
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

for (const [selector, option] of [
  ["#time-series", toEChartsViewTimeSeriesOption(timeSeriesFrame)],
  ["#latest-values", toEChartsViewLatestValuesOption(latestValuesFrame)],
  ["#histogram", toEChartsViewHistogramOption(histogramFrame)],
] as const) {
  init(requireContainer(selector)).setOption(option);
}
