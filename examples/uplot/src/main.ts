import { toUPlotLatestValuesArgs, toUPlotTimeSeriesArgs } from "@otlpkit/adapters/uplot";
import uPlot, { type AlignedData, type Options, type Series } from "uplot";
import "uplot/dist/uPlot.min.css";

import { query } from "../../shared/store.js";

function requireContainer(selector: string): HTMLDivElement {
  const container = document.querySelector<HTMLDivElement>(selector);
  if (!container) {
    throw new Error(`Expected ${selector} container to exist.`);
  }
  return container;
}

// Query the RowGroupStore via ScanEngine
const result = query();

const timeSeriesModel = toUPlotTimeSeriesArgs(result, {
  timestampUnit: "nanoseconds",
  title: "HTTP request duration by route",
});
const latestValuesModel = toUPlotLatestValuesArgs(result, {
  timestampUnit: "nanoseconds",
  title: "Latest values by route",
});

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
  series: timeSeriesModel.options.series.map(toUPlotSeries),
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
  series: latestValuesModel.options.series.map(toUPlotSeries),
};
const latestValuesData: AlignedData = [
  [...latestValuesModel.data[0]],
  [...latestValuesModel.data[1]],
];

new uPlot(timeSeriesOptions, timeSeriesModel.data as AlignedData, requireContainer("#time-series"));
new uPlot(latestValuesOptions, latestValuesData, requireContainer("#latest-values"));

function toUPlotSeries(series: (typeof timeSeriesModel.options.series)[number]): Series {
  return {
    label: series.label,
    ...(series.points ? { points: { ...series.points } } : {}),
  };
}
