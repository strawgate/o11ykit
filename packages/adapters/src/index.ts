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
  toRechartsEngineLatestValuesModel,
  toRechartsEngineTimeSeriesModel,
  toRechartsHistogramModel,
  toRechartsLatestValuesModel,
  toRechartsTimeSeriesModel,
} from "./recharts.js";
import {
  toTremorAreaChartProps,
  toTremorBarChartProps,
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
} from "./tremor.js";
import { toUPlotLatestValuesModel, toUPlotTimeSeriesModel } from "./uplot.js";
import { traceWaterfallToLaneRows } from "./waterfall.js";

export const adapterModules: {
  readonly toChartJsHistogramConfig: typeof toChartJsHistogramConfig;
  readonly toChartJsLatestValuesConfig: typeof toChartJsLatestValuesConfig;
  readonly toChartJsLineConfig: typeof toChartJsLineConfig;
  readonly toEChartsHistogramOption: typeof toEChartsHistogramOption;
  readonly toEChartsLatestValuesOption: typeof toEChartsLatestValuesOption;
  readonly toEChartsTimeSeriesOption: typeof toEChartsTimeSeriesOption;
  readonly toRechartsEngineLatestValuesModel: typeof toRechartsEngineLatestValuesModel;
  readonly toRechartsEngineTimeSeriesModel: typeof toRechartsEngineTimeSeriesModel;
  readonly toRechartsHistogramModel: typeof toRechartsHistogramModel;
  readonly toRechartsLatestValuesModel: typeof toRechartsLatestValuesModel;
  readonly toRechartsTimeSeriesModel: typeof toRechartsTimeSeriesModel;
  readonly toTremorAreaChartProps: typeof toTremorAreaChartProps;
  readonly toTremorBarChartProps: typeof toTremorBarChartProps;
  readonly toTremorBarListProps: typeof toTremorBarListProps;
  readonly toTremorDonutChartProps: typeof toTremorDonutChartProps;
  readonly toTremorLineChartProps: typeof toTremorLineChartProps;
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
  toRechartsEngineLatestValuesModel,
  toRechartsEngineTimeSeriesModel,
  toRechartsHistogramModel,
  toRechartsLatestValuesModel,
  toRechartsTimeSeriesModel,
  toTremorAreaChartProps,
  toTremorBarChartProps,
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
  toUPlotLatestValuesModel,
  toUPlotTimeSeriesModel,
  traceWaterfallToLaneRows,
};

export type {
  EngineAdapterOptions,
  EngineLabels,
  EngineLatestValueModel,
  EngineLatestValueRow,
  EngineLineSeries,
  EngineLineSeriesModel,
  EnginePoint,
  EngineQueryResult,
  EngineSeriesResult,
  EngineTimestampUnit,
  EngineWideRow,
  EngineWideTableModel,
} from "./engine.js";
export {
  toEngineLatestValueModel,
  toEngineLineSeriesModel,
  toEngineWideTableModel,
} from "./engine.js";
export type {
  TremorAreaChartProps,
  TremorBarChartProps,
  TremorBarListProps,
  TremorDonutChartProps,
  TremorLatestOptions,
  TremorLineLikeProps,
  TremorSeriesDescriptor,
  TremorXYOptions,
} from "./tremor.js";
export {
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsLineConfig,
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
  toRechartsEngineLatestValuesModel,
  toRechartsEngineTimeSeriesModel,
  toRechartsHistogramModel,
  toRechartsLatestValuesModel,
  toRechartsTimeSeriesModel,
  toTremorAreaChartProps,
  toTremorBarChartProps,
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
  toUPlotLatestValuesModel,
  toUPlotTimeSeriesModel,
  traceWaterfallToLaneRows,
};
