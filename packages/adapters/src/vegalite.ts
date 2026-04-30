import {
  asEngineHistogramModel,
  asEngineWideTableModel,
  type EngineAdapterOptions,
  type EngineHistogramInput,
  type EngineHistogramOptions,
  type EngineWideTableInput,
} from "./engine.js";
import { tidyRows } from "./engine-chart-shared.js";

export type VegaLiteMark = "line" | "area" | "bar" | "point";

export interface VegaLiteSpec {
  readonly $schema: "https://vega.github.io/schema/vega-lite/v6.json";
  readonly data: { readonly values: readonly Record<string, unknown>[] };
  readonly mark: VegaLiteMark;
  readonly encoding: Record<string, unknown>;
  readonly config: {
    readonly invalidValues: "filter";
  };
}

export function toVegaLiteSpec(
  model: EngineWideTableInput,
  options: EngineAdapterOptions & { readonly mark?: "line" | "area" | "bar" | "scatter" } = {}
): VegaLiteSpec {
  const wide = asEngineWideTableModel(model, options);
  const mark = options.mark === "scatter" ? "point" : (options.mark ?? "line");
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { values: tidyRows(wide).filter((row) => row.value !== null) },
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

export function toVegaLiteHistogramSpec(
  model: EngineHistogramInput,
  options: EngineAdapterOptions & EngineHistogramOptions = {}
): VegaLiteSpec {
  const histogram = asEngineHistogramModel(model, options);
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: {
      values: histogram.buckets.map((bucket) => ({
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
