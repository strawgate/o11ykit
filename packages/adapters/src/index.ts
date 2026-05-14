import {
  toAgChartsHistogramOptions,
  toAgChartsLatestValuesOptions,
  toAgChartsTimeSeriesOptions,
  toAgChartsUpdateDelta,
} from "./agcharts.js";
import {
  toApexChartsHistogramOptions,
  toApexChartsLatestValuesOptions,
  toApexChartsSeriesUpdate,
  toApexChartsTimeSeriesOptions,
} from "./apexcharts.js";
import {
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsTimeSeriesConfig,
  toChartJsViewHistogramConfig,
  toChartJsViewLatestValuesConfig,
  toChartJsViewLineConfig,
} from "./chartjs.js";
import {
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
  toEChartsViewHistogramOption,
  toEChartsViewLatestValuesOption,
  toEChartsViewTimeSeriesOption,
} from "./echarts.js";
import {
  toHighchartsHistogramOptions,
  toHighchartsLatestValuesOptions,
  toHighchartsTimeSeriesOptions,
} from "./highcharts.js";
import {
  toNivoBarData,
  toNivoBarProps,
  toNivoHistogramBarData,
  toNivoHistogramBarProps,
  toNivoLatestBarData,
  toNivoLatestBarProps,
  toNivoLineProps,
  toNivoLineSeries,
  toNivoPieData,
  toNivoPieProps,
  toNivoScatterSeries,
} from "./nivo.js";
import { toObservablePlotHistogramOptions, toObservablePlotOptions } from "./observable.js";
import {
  toPlotlyHistogramFigure,
  toPlotlyLatestValuesFigure,
  toPlotlyTimeSeriesFigure,
} from "./plotly.js";
import {
  toRechartsHistogramData,
  toRechartsLatestValuesData,
  toRechartsScatterData,
  toRechartsTimeSeriesData,
  toRechartsViewHistogramData,
  toRechartsViewLatestValuesData,
  toRechartsViewTimeSeriesData,
} from "./recharts.js";
import {
  toTremorAreaChartProps,
  toTremorBarChartProps,
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
} from "./tremor.js";
import {
  toUPlotLatestValuesArgs,
  toUPlotTimeSeriesArgs,
  toUPlotViewLatestValuesArgs,
  toUPlotViewTimeSeriesArgs,
} from "./uplot.js";
import { toVegaLiteHistogramSpec, toVegaLiteSpec } from "./vegalite.js";
import { toVictoryChartProps, toVictoryLatestData, toVictorySeries } from "./victory.js";
import { toVisxHistogramModel, toVisxLatestValuesModel, toVisxXYChartModel } from "./visx.js";
import { traceWaterfallToLaneRows } from "./waterfall.js";

export const adapterModules: {
  readonly toAgChartsHistogramOptions: typeof toAgChartsHistogramOptions;
  readonly toAgChartsLatestValuesOptions: typeof toAgChartsLatestValuesOptions;
  readonly toAgChartsTimeSeriesOptions: typeof toAgChartsTimeSeriesOptions;
  readonly toAgChartsUpdateDelta: typeof toAgChartsUpdateDelta;
  readonly toApexChartsHistogramOptions: typeof toApexChartsHistogramOptions;
  readonly toApexChartsLatestValuesOptions: typeof toApexChartsLatestValuesOptions;
  readonly toApexChartsSeriesUpdate: typeof toApexChartsSeriesUpdate;
  readonly toApexChartsTimeSeriesOptions: typeof toApexChartsTimeSeriesOptions;
  readonly toChartJsViewHistogramConfig: typeof toChartJsViewHistogramConfig;
  readonly toChartJsHistogramConfig: typeof toChartJsHistogramConfig;
  readonly toChartJsLatestValuesConfig: typeof toChartJsLatestValuesConfig;
  readonly toChartJsTimeSeriesConfig: typeof toChartJsTimeSeriesConfig;
  readonly toChartJsViewLatestValuesConfig: typeof toChartJsViewLatestValuesConfig;
  readonly toChartJsViewLineConfig: typeof toChartJsViewLineConfig;
  readonly toEChartsHistogramOption: typeof toEChartsHistogramOption;
  readonly toEChartsLatestValuesOption: typeof toEChartsLatestValuesOption;
  readonly toEChartsTimeSeriesOption: typeof toEChartsTimeSeriesOption;
  readonly toEChartsViewHistogramOption: typeof toEChartsViewHistogramOption;
  readonly toEChartsViewLatestValuesOption: typeof toEChartsViewLatestValuesOption;
  readonly toEChartsViewTimeSeriesOption: typeof toEChartsViewTimeSeriesOption;
  readonly toHighchartsHistogramOptions: typeof toHighchartsHistogramOptions;
  readonly toHighchartsLatestValuesOptions: typeof toHighchartsLatestValuesOptions;
  readonly toHighchartsTimeSeriesOptions: typeof toHighchartsTimeSeriesOptions;
  readonly toNivoBarData: typeof toNivoBarData;
  readonly toNivoBarProps: typeof toNivoBarProps;
  readonly toNivoHistogramBarData: typeof toNivoHistogramBarData;
  readonly toNivoHistogramBarProps: typeof toNivoHistogramBarProps;
  readonly toNivoLatestBarData: typeof toNivoLatestBarData;
  readonly toNivoLatestBarProps: typeof toNivoLatestBarProps;
  readonly toNivoLineSeries: typeof toNivoLineSeries;
  readonly toNivoLineProps: typeof toNivoLineProps;
  readonly toNivoPieData: typeof toNivoPieData;
  readonly toNivoPieProps: typeof toNivoPieProps;
  readonly toNivoScatterSeries: typeof toNivoScatterSeries;
  readonly toObservablePlotHistogramOptions: typeof toObservablePlotHistogramOptions;
  readonly toObservablePlotOptions: typeof toObservablePlotOptions;
  readonly toPlotlyHistogramFigure: typeof toPlotlyHistogramFigure;
  readonly toPlotlyLatestValuesFigure: typeof toPlotlyLatestValuesFigure;
  readonly toPlotlyTimeSeriesFigure: typeof toPlotlyTimeSeriesFigure;
  readonly toRechartsLatestValuesData: typeof toRechartsLatestValuesData;
  readonly toRechartsHistogramData: typeof toRechartsHistogramData;
  readonly toRechartsScatterData: typeof toRechartsScatterData;
  readonly toRechartsTimeSeriesData: typeof toRechartsTimeSeriesData;
  readonly toRechartsViewHistogramData: typeof toRechartsViewHistogramData;
  readonly toRechartsViewLatestValuesData: typeof toRechartsViewLatestValuesData;
  readonly toRechartsViewTimeSeriesData: typeof toRechartsViewTimeSeriesData;
  readonly toTremorAreaChartProps: typeof toTremorAreaChartProps;
  readonly toTremorBarChartProps: typeof toTremorBarChartProps;
  readonly toTremorBarListProps: typeof toTremorBarListProps;
  readonly toTremorDonutChartProps: typeof toTremorDonutChartProps;
  readonly toTremorLineChartProps: typeof toTremorLineChartProps;
  readonly toUPlotLatestValuesArgs: typeof toUPlotLatestValuesArgs;
  readonly toUPlotTimeSeriesArgs: typeof toUPlotTimeSeriesArgs;
  readonly toUPlotViewLatestValuesArgs: typeof toUPlotViewLatestValuesArgs;
  readonly toUPlotViewTimeSeriesArgs: typeof toUPlotViewTimeSeriesArgs;
  readonly toVegaLiteHistogramSpec: typeof toVegaLiteHistogramSpec;
  readonly toVegaLiteSpec: typeof toVegaLiteSpec;
  readonly toVictoryChartProps: typeof toVictoryChartProps;
  readonly toVictoryLatestData: typeof toVictoryLatestData;
  readonly toVictorySeries: typeof toVictorySeries;
  readonly toVisxHistogramModel: typeof toVisxHistogramModel;
  readonly toVisxLatestValuesModel: typeof toVisxLatestValuesModel;
  readonly toVisxXYChartModel: typeof toVisxXYChartModel;
  readonly traceWaterfallToLaneRows: typeof traceWaterfallToLaneRows;
} = {
  toAgChartsHistogramOptions,
  toAgChartsLatestValuesOptions,
  toAgChartsTimeSeriesOptions,
  toAgChartsUpdateDelta,
  toApexChartsHistogramOptions,
  toApexChartsLatestValuesOptions,
  toApexChartsSeriesUpdate,
  toApexChartsTimeSeriesOptions,
  toChartJsViewHistogramConfig,
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsTimeSeriesConfig,
  toChartJsViewLatestValuesConfig,
  toChartJsViewLineConfig,
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
  toEChartsViewHistogramOption,
  toEChartsViewLatestValuesOption,
  toEChartsViewTimeSeriesOption,
  toHighchartsHistogramOptions,
  toHighchartsLatestValuesOptions,
  toHighchartsTimeSeriesOptions,
  toNivoBarData,
  toNivoBarProps,
  toNivoHistogramBarData,
  toNivoHistogramBarProps,
  toNivoLatestBarData,
  toNivoLatestBarProps,
  toNivoLineSeries,
  toNivoLineProps,
  toNivoPieData,
  toNivoPieProps,
  toNivoScatterSeries,
  toObservablePlotHistogramOptions,
  toObservablePlotOptions,
  toPlotlyHistogramFigure,
  toPlotlyLatestValuesFigure,
  toPlotlyTimeSeriesFigure,
  toRechartsLatestValuesData,
  toRechartsHistogramData,
  toRechartsScatterData,
  toRechartsTimeSeriesData,
  toRechartsViewHistogramData,
  toRechartsViewLatestValuesData,
  toRechartsViewTimeSeriesData,
  toTremorAreaChartProps,
  toTremorBarChartProps,
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
  toUPlotLatestValuesArgs,
  toUPlotTimeSeriesArgs,
  toUPlotViewLatestValuesArgs,
  toUPlotViewTimeSeriesArgs,
  toVegaLiteHistogramSpec,
  toVegaLiteSpec,
  toVictoryChartProps,
  toVictoryLatestData,
  toVictorySeries,
  toVisxHistogramModel,
  toVisxLatestValuesModel,
  toVisxXYChartModel,
  traceWaterfallToLaneRows,
};

export {
  toAgChartsHistogramOptions,
  toAgChartsLatestValuesOptions,
  toAgChartsTimeSeriesOptions,
  toAgChartsUpdateDelta,
} from "./agcharts.js";
export {
  toApexChartsHistogramOptions,
  toApexChartsLatestValuesOptions,
  toApexChartsSeriesUpdate,
  toApexChartsTimeSeriesOptions,
} from "./apexcharts.js";
export type {
  RechartsCategoryData,
  RechartsScatterData,
  RechartsSeriesDescriptor,
  RechartsTimeSeriesData,
  RechartsTimeSeriesOptions,
  RechartsViewTimeSeriesData,
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
  toChartJsHistogramConfig,
  toChartJsLatestValuesConfig,
  toChartJsTimeSeriesConfig,
  toChartJsViewHistogramConfig,
  toChartJsViewLatestValuesConfig,
  toChartJsViewLineConfig,
  toEChartsHistogramOption,
  toEChartsLatestValuesOption,
  toEChartsTimeSeriesOption,
  toEChartsViewHistogramOption,
  toEChartsViewLatestValuesOption,
  toEChartsViewTimeSeriesOption,
  toHighchartsHistogramOptions,
  toHighchartsLatestValuesOptions,
  toHighchartsTimeSeriesOptions,
  toNivoBarData,
  toNivoBarProps,
  toNivoHistogramBarData,
  toNivoHistogramBarProps,
  toNivoLatestBarData,
  toNivoLatestBarProps,
  toNivoLineProps,
  toNivoLineSeries,
  toNivoPieData,
  toNivoPieProps,
  toNivoScatterSeries,
  toObservablePlotHistogramOptions,
  toObservablePlotOptions,
  toPlotlyHistogramFigure,
  toPlotlyLatestValuesFigure,
  toPlotlyTimeSeriesFigure,
  toRechartsHistogramData,
  toRechartsLatestValuesData,
  toRechartsScatterData,
  toRechartsTimeSeriesData,
  toRechartsViewHistogramData,
  toRechartsViewLatestValuesData,
  toRechartsViewTimeSeriesData,
  toTremorAreaChartProps,
  toTremorBarChartProps,
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
  toUPlotLatestValuesArgs,
  toUPlotTimeSeriesArgs,
  toUPlotViewLatestValuesArgs,
  toUPlotViewTimeSeriesArgs,
  toVegaLiteHistogramSpec,
  toVegaLiteSpec,
  toVictoryChartProps,
  toVictoryLatestData,
  toVictorySeries,
  toVisxHistogramModel,
  toVisxLatestValuesModel,
  toVisxXYChartModel,
  traceWaterfallToLaneRows,
};
