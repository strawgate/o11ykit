import {
  toAgChartsEngineLatestValuesOptions,
  toAgChartsEngineTimeSeriesOptions,
} from "./agcharts.js";
import {
  toApexChartsEngineLatestValuesOptions,
  toApexChartsEngineTimeSeriesOptions,
} from "./apexcharts.js";
import {
  toChartJsEngineHistogramConfig,
  toChartJsEngineLatestValuesConfig,
  toChartJsEngineTimeSeriesConfig,
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsLineConfig,
} from "./chartjs.js";
import {
  toEChartsEngineHistogramOption,
  toEChartsEngineLatestValuesOption,
  toEChartsEngineTimeSeriesOption,
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
} from "./echarts.js";
import {
  toHighchartsEngineHistogramOptions,
  toHighchartsEngineLatestValuesOptions,
  toHighchartsEngineTimeSeriesOptions,
} from "./highcharts.js";
import {
  toNivoEngineBarModel,
  toNivoEngineLineSeries,
  toNivoEnginePieData,
  toNivoEngineScatterSeries,
} from "./nivo.js";
import { toObservablePlotEngineHistogramModel, toObservablePlotEngineModel } from "./observable.js";
import {
  toPlotlyEngineHistogramModel,
  toPlotlyEngineLatestValuesModel,
  toPlotlyEngineTimeSeriesModel,
} from "./plotly.js";
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
import {
  toUPlotEngineLatestValuesModel,
  toUPlotEngineTimeSeriesModel,
  toUPlotLatestValuesModel,
  toUPlotTimeSeriesModel,
} from "./uplot.js";
import { toVegaLiteEngineHistogramSpec, toVegaLiteEngineSpec } from "./vegalite.js";
import { toVictoryEngineLatestData, toVictoryEngineSeries } from "./victory.js";
import { traceWaterfallToLaneRows } from "./waterfall.js";

export const adapterModules: {
  readonly toAgChartsEngineLatestValuesOptions: typeof toAgChartsEngineLatestValuesOptions;
  readonly toAgChartsEngineTimeSeriesOptions: typeof toAgChartsEngineTimeSeriesOptions;
  readonly toApexChartsEngineLatestValuesOptions: typeof toApexChartsEngineLatestValuesOptions;
  readonly toApexChartsEngineTimeSeriesOptions: typeof toApexChartsEngineTimeSeriesOptions;
  readonly toChartJsHistogramConfig: typeof toChartJsHistogramConfig;
  readonly toChartJsEngineHistogramConfig: typeof toChartJsEngineHistogramConfig;
  readonly toChartJsEngineLatestValuesConfig: typeof toChartJsEngineLatestValuesConfig;
  readonly toChartJsEngineTimeSeriesConfig: typeof toChartJsEngineTimeSeriesConfig;
  readonly toChartJsLatestValuesConfig: typeof toChartJsLatestValuesConfig;
  readonly toChartJsLineConfig: typeof toChartJsLineConfig;
  readonly toEChartsEngineHistogramOption: typeof toEChartsEngineHistogramOption;
  readonly toEChartsEngineLatestValuesOption: typeof toEChartsEngineLatestValuesOption;
  readonly toEChartsEngineTimeSeriesOption: typeof toEChartsEngineTimeSeriesOption;
  readonly toEChartsHistogramOption: typeof toEChartsHistogramOption;
  readonly toEChartsLatestValuesOption: typeof toEChartsLatestValuesOption;
  readonly toEChartsTimeSeriesOption: typeof toEChartsTimeSeriesOption;
  readonly toHighchartsEngineHistogramOptions: typeof toHighchartsEngineHistogramOptions;
  readonly toHighchartsEngineLatestValuesOptions: typeof toHighchartsEngineLatestValuesOptions;
  readonly toHighchartsEngineTimeSeriesOptions: typeof toHighchartsEngineTimeSeriesOptions;
  readonly toNivoEngineBarModel: typeof toNivoEngineBarModel;
  readonly toNivoEngineLineSeries: typeof toNivoEngineLineSeries;
  readonly toNivoEnginePieData: typeof toNivoEnginePieData;
  readonly toNivoEngineScatterSeries: typeof toNivoEngineScatterSeries;
  readonly toObservablePlotEngineHistogramModel: typeof toObservablePlotEngineHistogramModel;
  readonly toObservablePlotEngineModel: typeof toObservablePlotEngineModel;
  readonly toPlotlyEngineHistogramModel: typeof toPlotlyEngineHistogramModel;
  readonly toPlotlyEngineLatestValuesModel: typeof toPlotlyEngineLatestValuesModel;
  readonly toPlotlyEngineTimeSeriesModel: typeof toPlotlyEngineTimeSeriesModel;
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
  readonly toUPlotEngineLatestValuesModel: typeof toUPlotEngineLatestValuesModel;
  readonly toUPlotEngineTimeSeriesModel: typeof toUPlotEngineTimeSeriesModel;
  readonly toUPlotLatestValuesModel: typeof toUPlotLatestValuesModel;
  readonly toUPlotTimeSeriesModel: typeof toUPlotTimeSeriesModel;
  readonly toVegaLiteEngineHistogramSpec: typeof toVegaLiteEngineHistogramSpec;
  readonly toVegaLiteEngineSpec: typeof toVegaLiteEngineSpec;
  readonly toVictoryEngineLatestData: typeof toVictoryEngineLatestData;
  readonly toVictoryEngineSeries: typeof toVictoryEngineSeries;
  readonly traceWaterfallToLaneRows: typeof traceWaterfallToLaneRows;
} = {
  toAgChartsEngineLatestValuesOptions,
  toAgChartsEngineTimeSeriesOptions,
  toApexChartsEngineLatestValuesOptions,
  toApexChartsEngineTimeSeriesOptions,
  toChartJsHistogramConfig,
  toChartJsEngineHistogramConfig,
  toChartJsEngineLatestValuesConfig,
  toChartJsEngineTimeSeriesConfig,
  toChartJsLatestValuesConfig,
  toChartJsLineConfig,
  toEChartsEngineHistogramOption,
  toEChartsEngineLatestValuesOption,
  toEChartsEngineTimeSeriesOption,
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
  toHighchartsEngineHistogramOptions,
  toHighchartsEngineLatestValuesOptions,
  toHighchartsEngineTimeSeriesOptions,
  toNivoEngineBarModel,
  toNivoEngineLineSeries,
  toNivoEnginePieData,
  toNivoEngineScatterSeries,
  toObservablePlotEngineHistogramModel,
  toObservablePlotEngineModel,
  toPlotlyEngineHistogramModel,
  toPlotlyEngineLatestValuesModel,
  toPlotlyEngineTimeSeriesModel,
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
  toUPlotEngineLatestValuesModel,
  toUPlotEngineTimeSeriesModel,
  toUPlotLatestValuesModel,
  toUPlotTimeSeriesModel,
  toVegaLiteEngineHistogramSpec,
  toVegaLiteEngineSpec,
  toVictoryEngineLatestData,
  toVictoryEngineSeries,
  traceWaterfallToLaneRows,
};

export {
  toAgChartsEngineLatestValuesOptions,
  toAgChartsEngineTimeSeriesOptions,
} from "./agcharts.js";
export {
  toApexChartsEngineLatestValuesOptions,
  toApexChartsEngineTimeSeriesOptions,
} from "./apexcharts.js";
export type {
  EngineAdapterOptions,
  EngineHistogramBucket,
  EngineHistogramModel,
  EngineHistogramOptions,
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
  toEngineHistogramModel,
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
  toChartJsEngineHistogramConfig,
  toChartJsEngineLatestValuesConfig,
  toChartJsEngineTimeSeriesConfig,
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsLineConfig,
  toEChartsEngineHistogramOption,
  toEChartsEngineLatestValuesOption,
  toEChartsEngineTimeSeriesOption,
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
  toHighchartsEngineHistogramOptions,
  toHighchartsEngineLatestValuesOptions,
  toHighchartsEngineTimeSeriesOptions,
  toNivoEngineBarModel,
  toNivoEngineLineSeries,
  toNivoEnginePieData,
  toNivoEngineScatterSeries,
  toObservablePlotEngineHistogramModel,
  toObservablePlotEngineModel,
  toPlotlyEngineHistogramModel,
  toPlotlyEngineLatestValuesModel,
  toPlotlyEngineTimeSeriesModel,
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
  toUPlotEngineLatestValuesModel,
  toUPlotEngineTimeSeriesModel,
  toUPlotLatestValuesModel,
  toUPlotTimeSeriesModel,
  toVegaLiteEngineHistogramSpec,
  toVegaLiteEngineSpec,
  toVictoryEngineLatestData,
  toVictoryEngineSeries,
  traceWaterfallToLaneRows,
};
