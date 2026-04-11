import type { HistogramFrame, LatestValuesFrame, TimeSeriesFrame } from "@otlpkit/views";

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
  readonly type: "line" | "bar";
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
      readonly backgroundColor?: string;
    }[];
  };
  readonly options: {
    readonly responsive: boolean;
    readonly animation: false;
    readonly parsing?: false;
    readonly normalized?: boolean;
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
