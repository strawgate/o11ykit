import type { EngineHistogramModel, EngineWideTableModel } from "./engine.js";
import { tidyRows } from "./engine-chart-shared.js";

export type VegaLiteEngineMark = "line" | "area" | "bar" | "point";

export interface VegaLiteEngineSpec {
  readonly data: { readonly values: readonly Record<string, unknown>[] };
  readonly mark: VegaLiteEngineMark;
  readonly encoding: Record<string, unknown>;
}

export function toVegaLiteEngineSpec(
  model: EngineWideTableModel,
  options: { readonly mark?: "line" | "area" | "bar" | "scatter" } = {}
): VegaLiteEngineSpec {
  const mark = options.mark === "scatter" ? "point" : (options.mark ?? "line");
  return {
    data: { values: tidyRows(model).filter((row) => row.value !== null) },
    mark,
    encoding: {
      x: { field: "time", type: "temporal" },
      y: { field: "value", type: "quantitative" },
      color: { field: "series", type: "nominal" },
    },
  };
}

export function toVegaLiteEngineHistogramSpec(model: EngineHistogramModel): VegaLiteEngineSpec {
  return {
    data: {
      values: model.buckets.map((bucket) => ({
        label: bucket.label,
        count: bucket.count,
        start: bucket.start,
        end: bucket.end,
      })),
    },
    mark: "bar",
    encoding: {
      x: { field: "label" },
      y: { field: "count", type: "quantitative" },
    },
  };
}
