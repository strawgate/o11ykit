import type { EngineLatestValueModel, EngineWideTableModel } from "./engine.js";
import { rowToRecord } from "./engine-chart-shared.js";

export interface NivoPoint {
  readonly x: number;
  readonly y: number | null;
}

export interface NivoSeries {
  readonly id: string;
  readonly data: readonly NivoPoint[];
}

export interface NivoBarModel {
  readonly data: readonly Record<string, number | null>[];
  readonly keys: readonly string[];
  readonly indexBy: string;
}

export interface NivoLineProps {
  readonly data: readonly NivoSeries[];
  readonly xScale: { readonly type: "linear" };
  readonly yScale: { readonly type: "linear"; readonly stacked: boolean };
  readonly curve: "monotoneX" | "linear";
  readonly enablePoints: boolean;
}

export interface NivoBarProps extends NivoBarModel {
  readonly groupMode: "grouped" | "stacked";
}

export interface NivoPieProps {
  readonly data: readonly NivoPieDatum[];
  readonly id: "id";
  readonly value: "value";
}

export interface NivoPieDatum {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly color?: string;
}

export function toNivoEngineLineSeries(model: EngineWideTableModel): readonly NivoSeries[] {
  return model.series.map((series, index) => ({
    id: series.label,
    data: model.rows.map((row) => ({ x: row.t, y: row.values[index] ?? null })),
  }));
}

export function toNivoEngineLineProps(
  model: EngineWideTableModel,
  options: { readonly chartType?: "line" | "area" | "sparkline"; readonly stacked?: boolean } = {}
): NivoLineProps {
  return {
    data: toNivoEngineLineSeries(model),
    xScale: { type: "linear" },
    yScale: { type: "linear", stacked: options.stacked ?? options.chartType === "area" },
    curve: "monotoneX",
    enablePoints: options.chartType !== "sparkline",
  };
}

export function toNivoEngineBarModel(model: EngineWideTableModel): NivoBarModel {
  return {
    data: model.rows.map((row) => rowToRecord(row, model.series, "time")),
    keys: model.series.map((series) => series.id),
    indexBy: "time",
  };
}

export function toNivoEngineBarProps(
  model: EngineWideTableModel,
  options: { readonly groupMode?: "grouped" | "stacked" } = {}
): NivoBarProps {
  return {
    ...toNivoEngineBarModel(model),
    groupMode: options.groupMode ?? "grouped",
  };
}

export function toNivoEnginePieData(model: EngineLatestValueModel): readonly NivoPieDatum[] {
  return model.rows.flatMap((row) =>
    row.value === null
      ? []
      : [
          {
            id: row.label,
            label: row.label,
            value: row.value,
          },
        ]
  );
}

export function toNivoEnginePieProps(model: EngineLatestValueModel): NivoPieProps {
  return {
    data: toNivoEnginePieData(model),
    id: "id",
    value: "value",
  };
}

export function toNivoEngineScatterSeries(model: EngineWideTableModel): readonly NivoSeries[] {
  return toNivoEngineLineSeries(model);
}
