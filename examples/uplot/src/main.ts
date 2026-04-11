import { toUPlotLatestValuesModel, toUPlotTimeSeriesModel } from "@otlpkit/adapters/uplot";
import { buildLatestValuesFrame, buildTimeSeriesFrame } from "@otlpkit/views";
import uPlot, { type AlignedData, type Options } from "uplot";
import "uplot/dist/uPlot.min.css";

import { sampleMetricsDocument } from "../../shared/sample.js";

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

const timeSeriesModel = toUPlotTimeSeriesModel(timeSeriesFrame);
const latestValuesModel = toUPlotLatestValuesModel(latestValuesFrame);

const timeSeriesOptions: Options = {
  width: 960,
  height: 320,
  title: timeSeriesModel.options.title,
  scales: {
    x: {
      time: timeSeriesModel.options.scales.x.time,
    },
    y: {
      auto: timeSeriesModel.options.scales.y.auto,
    },
  },
  axes: timeSeriesModel.options.axes.map((axis) => ({ ...axis })),
  series: timeSeriesModel.options.series.map((series) => ({ ...series })),
};

const latestValuesOptions: Options = {
  width: 960,
  height: 320,
  title: latestValuesModel.options.title,
  scales: {
    x: {
      auto: latestValuesModel.options.scales.x.auto,
    },
    y: {
      auto: latestValuesModel.options.scales.y.auto,
    },
  },
  axes: latestValuesModel.options.axes.map((axis) => ({ ...axis })),
  series: latestValuesModel.options.series.map((series) => ({ ...series })),
};
const latestValuesData: AlignedData = [
  [...latestValuesModel.data[0]],
  [...latestValuesModel.data[1]],
];

new uPlot(timeSeriesOptions, timeSeriesModel.data as AlignedData, requireContainer("#time-series"));
new uPlot(latestValuesOptions, latestValuesData, requireContainer("#latest-values"));
