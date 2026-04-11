import {
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsLineConfig,
} from "./chartjs.js";
import {
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
} from "./echarts.js";
import {
  toRechartsHistogramModel,
  toRechartsLatestValuesModel,
  toRechartsTimeSeriesModel,
} from "./recharts.js";
import { toUPlotLatestValuesModel, toUPlotTimeSeriesModel } from "./uplot.js";
import { traceWaterfallToLaneRows } from "./waterfall.js";

export const adapterModules: {
  readonly toChartJsHistogramConfig: typeof toChartJsHistogramConfig;
  readonly toChartJsLatestValuesConfig: typeof toChartJsLatestValuesConfig;
  readonly toChartJsLineConfig: typeof toChartJsLineConfig;
  readonly toEChartsHistogramOption: typeof toEChartsHistogramOption;
  readonly toEChartsLatestValuesOption: typeof toEChartsLatestValuesOption;
  readonly toEChartsTimeSeriesOption: typeof toEChartsTimeSeriesOption;
  readonly toRechartsHistogramModel: typeof toRechartsHistogramModel;
  readonly toRechartsLatestValuesModel: typeof toRechartsLatestValuesModel;
  readonly toRechartsTimeSeriesModel: typeof toRechartsTimeSeriesModel;
  readonly toUPlotLatestValuesModel: typeof toUPlotLatestValuesModel;
  readonly toUPlotTimeSeriesModel: typeof toUPlotTimeSeriesModel;
  readonly traceWaterfallToLaneRows: typeof traceWaterfallToLaneRows;
} = {
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsLineConfig,
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
  toRechartsHistogramModel,
  toRechartsLatestValuesModel,
  toRechartsTimeSeriesModel,
  toUPlotLatestValuesModel,
  toUPlotTimeSeriesModel,
  traceWaterfallToLaneRows,
};

export {
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsLineConfig,
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
  toRechartsHistogramModel,
  toRechartsLatestValuesModel,
  toRechartsTimeSeriesModel,
  toUPlotLatestValuesModel,
  toUPlotTimeSeriesModel,
  traceWaterfallToLaneRows,
};
