import type { EngineHistogramModel, EngineWideTableModel } from "./engine.js";
import { tidyRows } from "./engine-chart-shared.js";

export type ObservablePlotMarkName = "lineY" | "areaY" | "barY" | "dot";

export interface ObservablePlotMark {
  readonly mark: ObservablePlotMarkName;
  readonly x: string;
  readonly y: string;
  readonly stroke?: string;
}

export interface ObservablePlotEngineModel {
  readonly data: readonly Record<string, unknown>[];
  readonly marks: readonly ObservablePlotMark[];
  readonly options: {
    readonly x: { readonly grid: boolean };
    readonly y: { readonly grid: boolean };
    readonly color?: { readonly legend: boolean };
  };
}

export function toObservablePlotEngineModel(
  model: EngineWideTableModel,
  options: { readonly chartType?: "line" | "area" | "bar" | "scatter" | "sparkline" } = {}
): ObservablePlotEngineModel {
  const chartType = options.chartType ?? "line";
  return {
    data: tidyRows(model),
    marks: [
      {
        mark:
          chartType === "bar"
            ? "barY"
            : chartType === "scatter"
              ? "dot"
              : chartType === "area"
                ? "areaY"
                : "lineY",
        x: "time",
        y: "value",
        stroke: "series",
      },
    ],
    options: {
      x: { grid: chartType !== "sparkline" },
      y: { grid: chartType !== "sparkline" },
      color: { legend: chartType !== "sparkline" },
    },
  };
}

export function toObservablePlotEngineHistogramModel(
  model: EngineHistogramModel
): ObservablePlotEngineModel {
  return {
    data: model.buckets.map((bucket) => ({
      label: bucket.label,
      count: bucket.count,
      start: bucket.start,
      end: bucket.end,
    })),
    marks: [{ mark: "barY", x: "label", y: "count" }],
    options: { x: { grid: false }, y: { grid: true } },
  };
}

export const toObservablePlotEnginePlotOptions: typeof toObservablePlotEngineModel =
  toObservablePlotEngineModel;
