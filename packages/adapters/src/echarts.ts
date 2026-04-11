import type { HistogramFrame, LatestValuesFrame, TimeSeriesFrame } from "@otlpkit/views";

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
    readonly type: "line" | "bar";
    readonly name: string;
    readonly datasetId: string;
    readonly encode: Record<string, string | string[]>;
    readonly showSymbol?: boolean;
    readonly emphasis?: {
      readonly focus: "series";
    };
  }[];
}

export function toEChartsTimeSeriesOption(frame: TimeSeriesFrame): EChartsOption {
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

export function toEChartsLatestValuesOption(frame: LatestValuesFrame): EChartsOption {
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

export function toEChartsHistogramOption(frame: HistogramFrame): EChartsOption {
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
