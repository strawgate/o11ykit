import type { EngineLatestValueModel, EngineWideTableModel } from "./engine.js";

export interface VictoryDatum {
  readonly x: number | string;
  readonly y: number | null;
}

export interface VictorySeries {
  readonly key: string;
  readonly label: string;
  readonly data: readonly VictoryDatum[];
  readonly component: "VictoryLine" | "VictoryArea" | "VictoryScatter";
}

export function toVictoryEngineSeries(
  model: EngineWideTableModel,
  options: { readonly chartType?: "line" | "area" | "scatter" } = {}
): readonly VictorySeries[] {
  const chartType = options.chartType ?? "line";
  return model.series.map((series, index) => ({
    key: series.id,
    label: series.label,
    data: model.rows.map((row) => ({ x: row.t, y: row.values[index] ?? null })),
    component:
      chartType === "scatter"
        ? "VictoryScatter"
        : chartType === "area"
          ? "VictoryArea"
          : "VictoryLine",
  }));
}

export function toVictoryEngineLatestData(model: EngineLatestValueModel): readonly VictoryDatum[] {
  return model.rows.flatMap((row) => (row.value === null ? [] : [{ x: row.label, y: row.value }]));
}
