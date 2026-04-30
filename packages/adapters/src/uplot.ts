import type { LatestValuesFrame, TimeSeriesFrame } from "@otlpkit/views";

import {
  asEngineLatestValueModel,
  asEngineWideTableModel,
  type EngineAdapterOptions,
  type EngineLatestValueInput,
  type EngineWideTableInput,
} from "./engine.js";
import { pivotTimeSeriesFrame } from "./shared.js";

export interface UPlotSeriesOption {
  readonly label: string;
  readonly fill?: boolean | undefined;
  readonly points?: {
    readonly show: boolean;
  };
}

export interface UPlotTimeSeriesArgs {
  readonly options: {
    readonly title: string;
    readonly scales: {
      readonly x: {
        readonly time: true;
      };
      readonly y: {
        readonly auto: true;
      };
    };
    readonly axes: readonly [
      {
        readonly scale: "x";
        readonly label: "Time (ms)";
      },
      {
        readonly scale: "y";
        readonly label: string;
      },
    ];
    readonly series: readonly UPlotSeriesOption[];
  };
  readonly data: readonly (readonly (number | null)[])[];
}

export interface UPlotLatestValuesArgs {
  readonly options: {
    readonly title: string;
    readonly scales: {
      readonly x: {
        readonly auto: false;
      };
      readonly y: {
        readonly auto: true;
      };
    };
    readonly axes: readonly [
      {
        readonly scale: "x";
        readonly label: "Series";
      },
      {
        readonly scale: "y";
        readonly label: string;
      },
    ];
    readonly series: readonly UPlotSeriesOption[];
  };
  readonly data: readonly [readonly number[], readonly number[]];
  readonly labels: readonly string[];
}

export interface UPlotAdapterOptions extends EngineAdapterOptions {
  readonly title?: string;
  readonly unit?: string | null;
  readonly chartType?: "line" | "area" | "sparkline";
}

export function toUPlotTimeSeriesArgs(
  model: EngineWideTableInput,
  options: UPlotAdapterOptions = {}
): UPlotTimeSeriesArgs {
  const wide = asEngineWideTableModel(model, options);
  return {
    options: {
      title: options.title ?? "",
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [
        {
          scale: "x",
          label: "Time (ms)",
        },
        {
          scale: "y",
          label: options.unit ?? "",
        },
      ],
      series: [
        { label: "time" },
        ...wide.series.map((series) => ({
          label: series.label,
          points: { show: false },
          fill: options.chartType === "area" ? true : undefined,
        })),
      ],
    },
    data: [
      wide.rows.map((row) => Math.round(row.t / 1000)),
      ...wide.series.map((_series, index) => wide.rows.map((row) => row.values[index] ?? null)),
    ],
  };
}

export function toUPlotLatestValuesArgs(
  model: EngineLatestValueInput,
  options: UPlotAdapterOptions = {}
): UPlotLatestValuesArgs {
  const rows = asEngineLatestValueModel(model, options).rows.filter((row) => row.value !== null);
  return {
    options: {
      title: options.title ?? "",
      scales: {
        x: { auto: false },
        y: { auto: true },
      },
      axes: [
        {
          scale: "x",
          label: "Series",
        },
        {
          scale: "y",
          label: options.unit ?? "",
        },
      ],
      series: [
        { label: "index" },
        {
          label: options.title ?? "latest",
          points: { show: false },
        },
      ],
    },
    data: [rows.map((_, index) => index), rows.map((row) => row.value ?? 0)],
    labels: rows.map((row) => row.label),
  };
}

export function toUPlotViewTimeSeriesArgs(frame: TimeSeriesFrame): UPlotTimeSeriesArgs {
  const pivoted = pivotTimeSeriesFrame(frame);
  const rows = pivoted.rows.filter(
    (row): row is typeof row & { readonly timeMs: number } => row.timeMs !== null
  );
  const xValues = rows.map((row) => row.timeMs);
  const yValues = frame.series.map((series) =>
    rows.map((row) => (row[series.key] as number | null) ?? null)
  );

  return {
    options: {
      title: frame.title,
      scales: {
        x: {
          time: true,
        },
        y: {
          auto: true,
        },
      },
      axes: [
        {
          scale: "x",
          label: "Time (ms)",
        },
        {
          scale: "y",
          label: frame.unit ?? "",
        },
      ],
      series: [
        {
          label: "time",
        },
        ...frame.series.map((series) => ({
          label: series.label,
          points: {
            show: false,
          },
        })),
      ],
    },
    data: [xValues, ...yValues],
  };
}

export function toUPlotViewLatestValuesArgs(frame: LatestValuesFrame): UPlotLatestValuesArgs {
  return {
    options: {
      title: frame.title,
      scales: {
        x: {
          auto: false,
        },
        y: {
          auto: true,
        },
      },
      axes: [
        {
          scale: "x",
          label: "Series",
        },
        {
          scale: "y",
          label: frame.unit ?? "",
        },
      ],
      series: [
        {
          label: "index",
        },
        {
          label: frame.title,
          points: {
            show: false,
          },
        },
      ],
    },
    data: [frame.rows.map((_, index) => index), frame.rows.map((row) => row.value)],
    labels: frame.rows.map((row) => row.label),
  };
}
