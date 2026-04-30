import type { HistogramFrame, LatestValuesFrame, TimeSeriesFrame } from "@otlpkit/views";

import type {
  EngineAdapterOptions,
  EngineHistogramInput,
  EngineHistogramOptions,
  EngineLatestValueInput,
  EngineLatestValueModel,
  EngineWideTableInput,
} from "./engine.js";
import {
  asEngineHistogramModel,
  asEngineLatestValueModel,
  asEngineWideTableModel,
} from "./engine.js";
import { histogramRows, pivotTimeSeriesFrame } from "./shared.js";

export interface EChartsDataset {
  readonly id: string;
  readonly dimensions?: readonly string[];
  readonly source: readonly Record<string, number | string | null>[];
}

export interface EChartsOption {
  readonly [key: string]: unknown;
  readonly aria: {
    readonly enabled: boolean;
  };
  readonly legend: {
    readonly type: "scroll";
  };
  readonly tooltip: {
    readonly trigger: "axis" | "item";
  };
  readonly dataset: readonly EChartsDataset[];
  readonly xAxis: {
    readonly type: "time" | "category";
  };
  readonly yAxis: {
    readonly type: "value";
    readonly name: string;
  };
  readonly series: readonly {
    readonly type: "line" | "bar" | "scatter" | "pie" | "gauge";
    readonly name: string;
    readonly datasetId: string;
    readonly encode: Record<string, string | string[]>;
    readonly data?: readonly unknown[];
    readonly showSymbol?: boolean;
    readonly areaStyle?: Record<string, unknown> | undefined;
    readonly emphasis?: {
      readonly focus: "series";
    };
  }[];
}

export type EChartsChartType =
  | "line"
  | "area"
  | "bar"
  | "donut"
  | "histogram"
  | "scatter"
  | "sparkline"
  | "gauge";

export interface EChartsOptions extends EngineAdapterOptions, EngineHistogramOptions {
  readonly chartType?: EChartsChartType;
  readonly unit?: string | null;
}

export function toEChartsTimeSeriesOption(
  model: EngineWideTableInput,
  options: EChartsOptions = {}
): EChartsOption {
  const wide = asEngineWideTableModel(model, options);
  const chartType = options.chartType ?? "line";
  return {
    aria: { enabled: true },
    legend: { type: "scroll" },
    tooltip: { trigger: "axis" },
    dataset: [
      {
        id: "telemetry",
        dimensions: ["time", ...wide.series.map((series) => series.label)],
        source: wide.rows.map((row) => {
          const output: Record<string, number | string | null> = { time: row.t };
          wide.series.forEach((series, index) => {
            output[series.label] = row.values[index] ?? null;
          });
          return output;
        }),
      },
    ],
    xAxis: { type: "time" },
    yAxis: { type: "value", name: options.unit ?? "" },
    series: wide.series.map((series) => ({
      type: chartType === "bar" ? "bar" : chartType === "scatter" ? "scatter" : "line",
      name: series.label,
      datasetId: "telemetry",
      encode: { x: "time", y: series.label, tooltip: ["time", series.label] },
      showSymbol: chartType !== "sparkline",
      areaStyle: chartType === "area" ? {} : undefined,
      emphasis: { focus: "series" },
    })),
  };
}

export function toEChartsLatestValuesOption(
  model: EngineLatestValueInput,
  options: EChartsOptions = {}
): EChartsOption {
  const latest = asEngineLatestValueModel(model, options);
  const chartType = options.chartType ?? "bar";
  if (chartType === "donut") {
    return {
      aria: { enabled: true },
      legend: { type: "scroll" },
      tooltip: { trigger: "item" },
      dataset: [],
      xAxis: { type: "category" },
      yAxis: { type: "value", name: options.unit ?? "" },
      series: [
        {
          type: "pie",
          name: "latest",
          datasetId: "",
          encode: {},
          data: latest.rows.flatMap((row) =>
            row.value === null ? [] : [{ name: row.label, value: row.value }]
          ),
        },
      ],
    };
  }
  if (chartType === "gauge") {
    return {
      aria: { enabled: true },
      legend: { type: "scroll" },
      tooltip: { trigger: "item" },
      dataset: [],
      xAxis: { type: "category" },
      yAxis: { type: "value", name: options.unit ?? "" },
      series: [
        {
          type: "gauge",
          name: "latest",
          datasetId: "",
          encode: {},
          data: [{ name: "average", value: gaugeValue(latest) }],
        },
      ],
    };
  }
  return {
    aria: { enabled: true },
    legend: { type: "scroll" },
    tooltip: { trigger: "item" },
    dataset: [
      {
        id: "latest-values",
        dimensions: ["label", "value"],
        source: latest.rows.flatMap((row) =>
          row.value === null ? [] : [{ label: row.label, value: row.value }]
        ),
      },
    ],
    xAxis: { type: "category" },
    yAxis: { type: "value", name: options.unit ?? "" },
    series: [
      {
        type: "bar",
        name: "latest",
        datasetId: "latest-values",
        encode: { x: "label", y: "value", tooltip: ["label", "value"] },
      },
    ],
  };
}

export function toEChartsHistogramOption(
  model: EngineHistogramInput,
  options: EChartsOptions = {}
): EChartsOption {
  const histogram = asEngineHistogramModel(model, options);
  return {
    aria: { enabled: true },
    legend: { type: "scroll" },
    tooltip: { trigger: "item" },
    dataset: [
      {
        id: "histogram",
        dimensions: ["label", "count", "start", "end"],
        source: histogram.buckets.map((bucket) => ({
          label: bucket.label,
          count: bucket.count,
          start: bucket.start,
          end: bucket.end,
        })),
      },
    ],
    xAxis: { type: "category" },
    yAxis: { type: "value", name: "Count" },
    series: [
      {
        type: "bar",
        name: "samples",
        datasetId: "histogram",
        encode: { x: "label", y: "count", tooltip: ["label", "count", "start", "end"] },
      },
    ],
  };
}

export function toEChartsViewTimeSeriesOption(frame: TimeSeriesFrame): EChartsOption {
  const pivoted = pivotTimeSeriesFrame(frame);

  return {
    aria: {
      enabled: true,
    },
    legend: {
      type: "scroll",
    },
    tooltip: {
      trigger: "axis",
    },
    dataset: [
      {
        id: "telemetry",
        dimensions: pivoted.dimensions,
        source: pivoted.rows,
      },
    ],
    xAxis: {
      type: "time",
    },
    yAxis: {
      type: "value",
      name: frame.unit ?? "",
    },
    series: frame.series.map((series) => ({
      type: "line",
      name: series.label,
      datasetId: "telemetry",
      encode: {
        x: "timeMs",
        y: series.key,
        tooltip: ["isoTime", series.key],
      },
      showSymbol: false,
      emphasis: {
        focus: "series",
      },
    })),
  };
}

function gaugeValue(model: EngineLatestValueModel): number {
  const values = model.rows
    .map((row) => row.value)
    .filter((value): value is number => value !== null);
  if (values.length === 0) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.round(Math.max(0, Math.min(200, average)));
}

export function toEChartsViewLatestValuesOption(frame: LatestValuesFrame): EChartsOption {
  return {
    aria: {
      enabled: true,
    },
    legend: {
      type: "scroll",
    },
    tooltip: {
      trigger: "item",
    },
    dataset: [
      {
        id: "latest-values",
        dimensions: ["label", "value"],
        source: frame.rows.map((row) => ({
          label: row.label,
          value: row.value,
        })),
      },
    ],
    xAxis: {
      type: "category",
    },
    yAxis: {
      type: "value",
      name: frame.unit ?? "",
    },
    series: [
      {
        type: "bar",
        name: frame.title,
        datasetId: "latest-values",
        encode: {
          x: "label",
          y: "value",
          tooltip: ["label", "value"],
        },
      },
    ],
  };
}

export function toEChartsViewHistogramOption(frame: HistogramFrame): EChartsOption {
  return {
    aria: {
      enabled: true,
    },
    legend: {
      type: "scroll",
    },
    tooltip: {
      trigger: "item",
    },
    dataset: [
      {
        id: "histogram",
        dimensions: ["label", "count", "start", "end"],
        source: histogramRows(frame),
      },
    ],
    xAxis: {
      type: "category",
    },
    yAxis: {
      type: "value",
      name: "Count",
    },
    series: [
      {
        type: "bar",
        name: frame.title,
        datasetId: "histogram",
        encode: {
          x: "label",
          y: "count",
          tooltip: ["label", "count", "start", "end"],
        },
      },
    ],
  };
}
