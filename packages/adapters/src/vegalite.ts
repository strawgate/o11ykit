import type { EngineHistogramModel, EngineWideTableModel } from "./engine.js";
import { tidyRows } from "./engine-chart-shared.js";

export type VegaLiteEngineMark = "line" | "area" | "bar" | "point";

export interface VegaLiteEngineSpec {
  readonly $schema: "https://vega.github.io/schema/vega-lite/v6.json";
  readonly data: { readonly values: readonly Record<string, unknown>[] };
  readonly mark: VegaLiteEngineMark;
  readonly encoding: Record<string, unknown>;
  readonly config: {
    readonly invalidValues: "filter";
  };
}

export function toVegaLiteEngineSpec(
  model: EngineWideTableModel,
  options: { readonly mark?: "line" | "area" | "bar" | "scatter" } = {}
): VegaLiteEngineSpec {
  const mark = options.mark === "scatter" ? "point" : (options.mark ?? "line");
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { values: tidyRows(model).filter((row) => row.value !== null) },
    mark,
    encoding: {
      x: { field: "time", type: "temporal" },
      y: { field: "value", type: "quantitative" },
      color: { field: "series", type: "nominal" },
      tooltip: [
        { field: "series", type: "nominal" },
        { field: "time", type: "temporal" },
        { field: "value", type: "quantitative" },
      ],
    },
    config: { invalidValues: "filter" },
  };
}

export function toVegaLiteEngineHistogramSpec(model: EngineHistogramModel): VegaLiteEngineSpec {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
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
      tooltip: [
        { field: "label", type: "nominal" },
        { field: "count", type: "quantitative" },
      ],
    },
    config: { invalidValues: "filter" },
  };
}
