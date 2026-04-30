import type { HistogramFrame, LatestValuesFrame, TimeSeriesFrame } from "@otlpkit/views";

import type {
  EngineHistogramModel,
  EngineLatestValueModel,
  EngineWideTableModel,
} from "./engine.js";

export interface ChartJsPoint {
  readonly x: number;
  readonly y: number | null;
}

export interface ChartJsLineDataset {
  readonly label: string;
  readonly data: ChartJsPoint[];
  readonly parsing: false;
  readonly normalized: boolean;
  readonly spanGaps: boolean;
  readonly borderWidth: number;
  readonly pointRadius: number;
  readonly tension: number;
}

export interface ChartJsConfig {
  readonly type: "line" | "bar" | "doughnut";
  readonly data: {
    readonly labels?: string[];
    readonly datasets: {
      readonly label: string;
      readonly data: unknown[];
      readonly parsing?: false;
      readonly normalized?: boolean;
      readonly spanGaps?: boolean;
      readonly borderWidth?: number;
      readonly pointRadius?: number;
      readonly tension?: number;
      readonly backgroundColor?: string | readonly string[] | undefined;
      readonly fill?: boolean | undefined;
    }[];
  };
  readonly options: {
    readonly responsive: boolean;
    readonly animation: false;
    readonly parsing?: false;
    readonly normalized?: boolean;
    readonly circumference?: number;
    readonly rotation?: number;
    readonly interaction?: {
      readonly mode: "nearest" | "index";
      readonly intersect: boolean;
    };
    readonly plugins: {
      readonly legend: {
        readonly display: boolean;
      };
      readonly title: {
        readonly display: boolean;
        readonly text: string;
      };
    };
    readonly scales: {
      readonly x: {
        readonly type: "linear" | "category";
        readonly title: {
          readonly display: boolean;
          readonly text: string;
        };
      };
      readonly y: {
        readonly type: "linear";
        readonly title: {
          readonly display: boolean;
          readonly text: string;
        };
      };
    };
  };
}

export type ChartJsEngineChartType =
  | "line"
  | "area"
  | "bar"
  | "donut"
  | "histogram"
  | "scatter"
  | "sparkline"
  | "gauge";

export interface ChartJsEngineOptions {
  readonly chartType?: ChartJsEngineChartType;
  readonly unit?: string | null;
  readonly title?: string;
  readonly spanGaps?: boolean;
}

export function toChartJsEngineTimeSeriesConfig(
  model: EngineWideTableModel,
  options: ChartJsEngineOptions = {}
): ChartJsConfig {
  const chartType = options.chartType ?? "line";
  return {
    type: chartType === "bar" ? "bar" : chartType === "scatter" ? "line" : "line",
    data: {
      datasets: model.series.map((series, index) => ({
        label: series.label,
        data: model.rows.map((row) => ({ x: row.t, y: row.values[index] ?? null })),
        parsing: false,
        normalized: true,
        spanGaps: options.spanGaps ?? false,
        borderWidth: 2,
        pointRadius: chartType === "scatter" ? 3 : 0,
        tension: chartType === "scatter" ? 0 : 0.25,
        backgroundColor: chartType === "area" ? "#4c8bf533" : undefined,
        fill: chartType === "area" ? true : undefined,
      })),
    },
    options: chartJsEngineOptions({
      xType: "linear",
      legend: chartType !== "sparkline" && model.series.length > 1,
      title: options.title ?? "",
      unit: options.unit ?? null,
      sparkline: chartType === "sparkline",
    }),
  };
}

export function toChartJsEngineLatestValuesConfig(
  model: EngineLatestValueModel,
  options: ChartJsEngineOptions = {}
): ChartJsConfig {
  const chartType = options.chartType ?? "bar";
  if (chartType === "donut" || chartType === "gauge") {
    const value = chartType === "gauge" ? gaugeValue(model) : undefined;
    return {
      type: "doughnut",
      data: {
        labels: chartType === "gauge" ? ["value", "remaining"] : model.rows.map((row) => row.label),
        datasets: [
          {
            label: options.title ?? "latest",
            data:
              chartType === "gauge"
                ? [value, Math.max(0, 200 - (value ?? 0))]
                : model.rows.flatMap((row) => (row.value === null ? [] : [row.value])),
            backgroundColor: chartType === "gauge" ? "#4c8bf5" : "#4c8bf5",
          },
        ],
      },
      options: {
        ...chartJsEngineOptions({
          xType: "category",
          legend: chartType === "donut",
          title: options.title ?? "",
          unit: options.unit ?? null,
        }),
        ...(chartType === "gauge" ? { circumference: 180, rotation: 270 } : {}),
      },
    };
  }

  return {
    type: "bar",
    data: {
      labels: model.rows.flatMap((row) => (row.value === null ? [] : [row.label])),
      datasets: [
        {
          label: options.title ?? "latest",
          data: model.rows.flatMap((row) => (row.value === null ? [] : [row.value])),
          backgroundColor: "#4c8bf5",
        },
      ],
    },
    options: chartJsEngineOptions({
      xType: "category",
      legend: false,
      title: options.title ?? "",
      unit: options.unit ?? null,
    }),
  };
}

export function toChartJsEngineHistogramConfig(
  model: EngineHistogramModel,
  options: ChartJsEngineOptions = {}
): ChartJsConfig {
  return {
    type: "bar",
    data: {
      labels: model.buckets.map((bucket) => bucket.label),
      datasets: [
        {
          label: options.title ?? "samples",
          data: model.buckets.map((bucket) => bucket.count),
          backgroundColor: "#0f9d58",
        },
      ],
    },
    options: chartJsEngineOptions({
      xType: "category",
      legend: false,
      title: options.title ?? "",
      unit: "Count",
    }),
  };
}

export function toChartJsLineConfig(
  frame: TimeSeriesFrame,
  options: {
    readonly xLabel?: string;
    readonly spanGaps?: boolean;
  } = {}
): ChartJsConfig {
  return {
    type: "line",
    data: {
      datasets: frame.series.map(
        (series): ChartJsLineDataset => ({
          label: series.label,
          data: series.points.map((point) => ({
            x: point.timeMs ?? 0,
            y: point.value,
          })),
          parsing: false,
          normalized: true,
          spanGaps: options.spanGaps ?? false,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0,
        })
      ),
    },
    options: {
      responsive: true,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: {
        mode: "nearest",
        intersect: false,
      },
      plugins: {
        legend: {
          display: frame.series.length > 1,
        },
        title: {
          display: frame.title.length > 0,
          text: frame.title,
        },
      },
      scales: {
        x: {
          type: "linear",
          title: {
            display: true,
            text: options.xLabel ?? "Time (ms)",
          },
        },
        y: {
          type: "linear",
          title: {
            display: Boolean(frame.unit),
            text: frame.unit ?? "",
          },
        },
      },
    },
  };
}

function chartJsEngineOptions(options: {
  readonly xType: "linear" | "category";
  readonly legend: boolean;
  readonly title: string;
  readonly unit: string | null;
  readonly sparkline?: boolean;
}): ChartJsConfig["options"] {
  return {
    responsive: true,
    animation: false,
    parsing: false,
    normalized: true,
    interaction: {
      mode: "nearest",
      intersect: false,
    },
    plugins: {
      legend: {
        display: options.sparkline ? false : options.legend,
      },
      title: {
        display: !options.sparkline && options.title.length > 0,
        text: options.title,
      },
    },
    scales: {
      x: {
        type: options.xType,
        title: {
          display: false,
          text: "",
        },
      },
      y: {
        type: "linear",
        title: {
          display: !options.sparkline && Boolean(options.unit),
          text: options.unit ?? "",
        },
      },
    },
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

export function toChartJsLatestValuesConfig(frame: LatestValuesFrame): ChartJsConfig {
  return {
    type: "bar",
    data: {
      labels: frame.rows.map((row) => row.label),
      datasets: [
        {
          label: frame.title,
          data: frame.rows.map((row) => row.value),
          backgroundColor: "#4c8bf5",
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: {
          display: false,
        },
        title: {
          display: frame.title.length > 0,
          text: frame.title,
        },
      },
      scales: {
        x: {
          type: "category",
          title: {
            display: false,
            text: "",
          },
        },
        y: {
          type: "linear",
          title: {
            display: Boolean(frame.unit),
            text: frame.unit ?? "",
          },
        },
      },
    },
  };
}

export function toChartJsHistogramConfig(frame: HistogramFrame): ChartJsConfig {
  return {
    type: "bar",
    data: {
      labels: frame.bins.map((bin) => bin.label),
      datasets: [
        {
          label: frame.title,
          data: frame.bins.map((bin) => bin.count),
          backgroundColor: "#0f9d58",
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: {
          display: false,
        },
        title: {
          display: frame.title.length > 0,
          text: frame.title,
        },
      },
      scales: {
        x: {
          type: "category",
          title: {
            display: false,
            text: "",
          },
        },
        y: {
          type: "linear",
          title: {
            display: true,
            text: "Count",
          },
        },
      },
    },
  };
}
