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

export function toNivoEngineBarModel(model: EngineWideTableModel): NivoBarModel {
  return {
    data: model.rows.map((row) => rowToRecord(row, model.series, "time")),
    keys: model.series.map((series) => series.id),
    indexBy: "time",
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

export function toNivoEngineScatterSeries(model: EngineWideTableModel): readonly NivoSeries[] {
  return toNivoEngineLineSeries(model);
}
