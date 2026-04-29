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
  };
}
