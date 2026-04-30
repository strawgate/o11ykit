import {
  toAgChartsEngineLatestValuesOptions,
  toAgChartsEngineTimeSeriesOptions,
  toAgChartsEngineUpdateDelta,
} from "./agcharts.js";
import {
  toApexChartsEngineLatestValuesOptions,
  toApexChartsEngineSeriesUpdate,
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
  toNivoEngineBarProps,
  toNivoEngineLineProps,
  toNivoEngineLineSeries,
  toNivoEnginePieData,
  toNivoEnginePieProps,
  toNivoEngineScatterSeries,
} from "./nivo.js";
import {
  toObservablePlotEngineHistogramModel,
  toObservablePlotEngineModel,
  toObservablePlotEnginePlotOptions,
} from "./observable.js";
import {
  toPlotlyEngineHistogramFigure,
  toPlotlyEngineHistogramModel,
  toPlotlyEngineLatestValuesFigure,
  toPlotlyEngineLatestValuesModel,
  toPlotlyEngineTimeSeriesFigure,
  toPlotlyEngineTimeSeriesModel,
} from "./plotly.js";
import {
  toRechartsEngineHistogramModel,
  toRechartsEngineLatestValuesModel,
  toRechartsEngineScatterModel,
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
import {
  toVictoryEngineChartProps,
  toVictoryEngineLatestData,
  toVictoryEngineSeries,
} from "./victory.js";
import {
  toVisxEngineHistogramModel,
  toVisxEngineLatestValuesModel,
  toVisxEngineXYChartModel,
} from "./visx.js";
import { traceWaterfallToLaneRows } from "./waterfall.js";

export const adapterModules: {
  readonly toAgChartsEngineLatestValuesOptions: typeof toAgChartsEngineLatestValuesOptions;
  readonly toAgChartsEngineTimeSeriesOptions: typeof toAgChartsEngineTimeSeriesOptions;
  readonly toAgChartsEngineUpdateDelta: typeof toAgChartsEngineUpdateDelta;
  readonly toApexChartsEngineLatestValuesOptions: typeof toApexChartsEngineLatestValuesOptions;
  readonly toApexChartsEngineSeriesUpdate: typeof toApexChartsEngineSeriesUpdate;
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
  readonly toNivoEngineBarProps: typeof toNivoEngineBarProps;
  readonly toNivoEngineLineSeries: typeof toNivoEngineLineSeries;
  readonly toNivoEngineLineProps: typeof toNivoEngineLineProps;
  readonly toNivoEnginePieData: typeof toNivoEnginePieData;
  readonly toNivoEnginePieProps: typeof toNivoEnginePieProps;
  readonly toNivoEngineScatterSeries: typeof toNivoEngineScatterSeries;
  readonly toObservablePlotEngineHistogramModel: typeof toObservablePlotEngineHistogramModel;
  readonly toObservablePlotEngineModel: typeof toObservablePlotEngineModel;
  readonly toObservablePlotEnginePlotOptions: typeof toObservablePlotEnginePlotOptions;
  readonly toPlotlyEngineHistogramFigure: typeof toPlotlyEngineHistogramFigure;
  readonly toPlotlyEngineHistogramModel: typeof toPlotlyEngineHistogramModel;
  readonly toPlotlyEngineLatestValuesFigure: typeof toPlotlyEngineLatestValuesFigure;
  readonly toPlotlyEngineLatestValuesModel: typeof toPlotlyEngineLatestValuesModel;
  readonly toPlotlyEngineTimeSeriesFigure: typeof toPlotlyEngineTimeSeriesFigure;
  readonly toPlotlyEngineTimeSeriesModel: typeof toPlotlyEngineTimeSeriesModel;
  readonly toRechartsEngineLatestValuesModel: typeof toRechartsEngineLatestValuesModel;
  readonly toRechartsEngineHistogramModel: typeof toRechartsEngineHistogramModel;
  readonly toRechartsEngineScatterModel: typeof toRechartsEngineScatterModel;
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
  readonly toVictoryEngineChartProps: typeof toVictoryEngineChartProps;
  readonly toVictoryEngineLatestData: typeof toVictoryEngineLatestData;
  readonly toVictoryEngineSeries: typeof toVictoryEngineSeries;
  readonly toVisxEngineHistogramModel: typeof toVisxEngineHistogramModel;
  readonly toVisxEngineLatestValuesModel: typeof toVisxEngineLatestValuesModel;
  readonly toVisxEngineXYChartModel: typeof toVisxEngineXYChartModel;
  readonly traceWaterfallToLaneRows: typeof traceWaterfallToLaneRows;
} = {
  toAgChartsEngineLatestValuesOptions,
  toAgChartsEngineTimeSeriesOptions,
  toAgChartsEngineUpdateDelta,
  toApexChartsEngineLatestValuesOptions,
  toApexChartsEngineSeriesUpdate,
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
  toNivoEngineBarProps,
  toNivoEngineLineSeries,
  toNivoEngineLineProps,
  toNivoEnginePieData,
  toNivoEnginePieProps,
  toNivoEngineScatterSeries,
  toObservablePlotEngineHistogramModel,
  toObservablePlotEngineModel,
  toObservablePlotEnginePlotOptions,
  toPlotlyEngineHistogramFigure,
  toPlotlyEngineHistogramModel,
  toPlotlyEngineLatestValuesFigure,
  toPlotlyEngineLatestValuesModel,
  toPlotlyEngineTimeSeriesFigure,
  toPlotlyEngineTimeSeriesModel,
  toRechartsEngineLatestValuesModel,
  toRechartsEngineHistogramModel,
  toRechartsEngineScatterModel,
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
  toVictoryEngineChartProps,
  toVictoryEngineLatestData,
  toVictoryEngineSeries,
  toVisxEngineHistogramModel,
  toVisxEngineLatestValuesModel,
  toVisxEngineXYChartModel,
  traceWaterfallToLaneRows,
};

export {
  toAgChartsEngineLatestValuesOptions,
  toAgChartsEngineTimeSeriesOptions,
  toAgChartsEngineUpdateDelta,
} from "./agcharts.js";
export {
  toApexChartsEngineLatestValuesOptions,
  toApexChartsEngineSeriesUpdate,
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
  RechartsBarModel,
  RechartsEngineScatterModel,
  RechartsEngineTimeSeriesModel,
  RechartsEngineTimeSeriesOptions,
  RechartsSeriesDescriptor,
  RechartsTimeSeriesModel,
} from "./recharts.js";
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
  toNivoEngineBarProps,
  toNivoEngineLineProps,
  toNivoEngineLineSeries,
  toNivoEnginePieData,
  toNivoEnginePieProps,
  toNivoEngineScatterSeries,
  toObservablePlotEngineHistogramModel,
  toObservablePlotEngineModel,
  toObservablePlotEnginePlotOptions,
  toPlotlyEngineHistogramFigure,
  toPlotlyEngineHistogramModel,
  toPlotlyEngineLatestValuesFigure,
  toPlotlyEngineLatestValuesModel,
  toPlotlyEngineTimeSeriesFigure,
  toPlotlyEngineTimeSeriesModel,
  toRechartsEngineHistogramModel,
  toRechartsEngineLatestValuesModel,
  toRechartsEngineScatterModel,
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
  toVictoryEngineChartProps,
  toVictoryEngineLatestData,
  toVictoryEngineSeries,
  toVisxEngineHistogramModel,
  toVisxEngineLatestValuesModel,
  toVisxEngineXYChartModel,
  traceWaterfallToLaneRows,
};
