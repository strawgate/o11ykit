import type { LatestValuesFrame, TimeSeriesFrame } from "@otlpkit/views";

import { pivotTimeSeriesFrame } from "./shared.js";

export interface UPlotSeriesOption {
  readonly label: string;
  readonly points?: {
    readonly show: boolean;
  };
}

export interface UPlotTimeSeriesModel {
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

export interface UPlotLatestValuesModel {
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

export function toUPlotTimeSeriesModel(frame: TimeSeriesFrame): UPlotTimeSeriesModel {
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

export function toUPlotLatestValuesModel(frame: LatestValuesFrame): UPlotLatestValuesModel {
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
