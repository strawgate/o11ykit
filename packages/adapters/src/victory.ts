import {
  asEngineLatestValueModel,
  asEngineWideTableModel,
  type EngineAdapterOptions,
  type EngineLatestValueInput,
  type EngineWideTableInput,
} from "./engine.js";

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

export interface VictoryChartProps {
  readonly scale: { readonly x: "time" };
  readonly domainPadding: { readonly x: number; readonly y: number };
  readonly series: readonly VictorySeries[];
}

export function toVictorySeries(
  model: EngineWideTableInput,
  options: EngineAdapterOptions & { readonly chartType?: "line" | "area" | "scatter" } = {}
): readonly VictorySeries[] {
  const wide = asEngineWideTableModel(model, options);
  const chartType = options.chartType ?? "line";
  return wide.series.map((series, index) => ({
    key: series.id,
    label: series.label,
    data: wide.rows.map((row) => ({ x: row.t, y: row.values[index] ?? null })),
    component:
      chartType === "scatter"
        ? "VictoryScatter"
        : chartType === "area"
          ? "VictoryArea"
          : "VictoryLine",
  }));
}

export function toVictoryChartProps(
  model: EngineWideTableInput,
  options: EngineAdapterOptions & { readonly chartType?: "line" | "area" | "scatter" } = {}
): VictoryChartProps {
  return {
    scale: { x: "time" },
    domainPadding: { x: 8, y: 12 },
    series: toVictorySeries(model, options),
  };
}

export function toVictoryLatestData(
  model: EngineLatestValueInput,
  options: EngineAdapterOptions = {}
): readonly VictoryDatum[] {
  return asEngineLatestValueModel(model, options).rows.flatMap((row) =>
    row.value === null ? [] : [{ x: row.label, y: row.value }]
  );
}
