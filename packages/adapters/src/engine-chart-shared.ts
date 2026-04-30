import type { EngineLatestValueModel, EngineWideRow, EngineWideTableModel } from "./engine.js";

export function rowToRecord(
  row: EngineWideRow,
  series: EngineWideTableModel["series"],
  timeKey = "time"
): Record<string, number | null> {
  const output: Record<string, number | null> = { [timeKey]: row.t };
  row.values.forEach((value, index) => {
    const key = series[index]?.id;
    if (key) {
      output[key] = value ?? null;
    }
  });
  return output;
}

export function tidyRows(model: EngineWideTableModel): Record<string, number | string | null>[] {
  return model.rows.flatMap((row) =>
    model.series.map((series, index) => ({
      time: row.t,
      value: row.values[index] ?? null,
      series: series.label,
      id: series.id,
    }))
  );
}

export function latestRows(model: EngineLatestValueModel): Record<string, number | string>[] {
  return model.rows.flatMap((row) =>
    row.value === null ? [] : [{ id: row.id, label: row.label, value: row.value }]
  );
}

export function gaugeValue(model: EngineLatestValueModel): number {
  const values = model.rows
    .map((row) => row.value)
    .filter((value): value is number => value !== null);
  if (values.length === 0) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.round(Math.max(0, Math.min(200, average)));
}
