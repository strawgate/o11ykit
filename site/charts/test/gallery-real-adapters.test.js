import { describe, expect, it } from "vitest";

import {
  toEngineLatestValueModel,
  toEngineWideTableModel,
} from "../../../packages/adapters/src/engine.js";
import { toRechartsEngineTimeSeriesModel } from "../../../packages/adapters/src/recharts.js";
import {
  toTremorBarListProps,
  toTremorDonutChartProps,
  toTremorLineChartProps,
} from "../../../packages/adapters/src/tremor.js";
import {
  createEngineResult,
  createGalleryState,
  toEngineLatestValueModel as toGalleryLatestValueModel,
  toEngineWideTableModel as toGalleryWideTableModel,
} from "../js/gallery-data.js";

describe("chart gallery integration with real adapters", () => {
  it("keeps the gallery engine fixture aligned with package engine models", () => {
    const result = createEngineResult();
    const galleryWide = toGalleryWideTableModel(result);
    const packageWide = toEngineWideTableModel(result, {
      seriesLabel: gallerySeriesLabel,
    });
    const galleryLatest = toGalleryLatestValueModel(result);
    const packageLatest = toEngineLatestValueModel(result, {
      seriesLabel: gallerySeriesLabel,
    });

    expect(galleryWide.series.map(({ id, label }) => ({ id, label }))).toEqual(
      packageWide.series.map(({ id, label }) => ({ id, label }))
    );
    expect(galleryWide.rows).toEqual(packageWide.rows);
    expect(galleryLatest.rows.map(({ id, label, t, value }) => ({ id, label, t, value }))).toEqual(
      packageLatest.rows.map(({ id, label, t, value }) => ({ id, label, t, value }))
    );
  });

  it("backs the Tremor gallery examples with implemented prop adapters", () => {
    const result = createEngineResult();
    const wide = toEngineWideTableModel(result, { seriesLabel: gallerySeriesLabel });
    const latest = toEngineLatestValueModel(result, { seriesLabel: gallerySeriesLabel });
    const line = toTremorLineChartProps(wide);
    const donut = toTremorDonutChartProps(latest);
    const barList = toTremorBarListProps(latest);
    const galleryLine = createGalleryState("tremor", "line").adapterModel;

    expect(line.index).toBe("time");
    expect(line.categories).toEqual(galleryLine.categories);
    expect(line.data[0]?.time).toBe(wide.rows[0]?.t);
    for (const category of line.categories) {
      expect(line.data[0]?.[category]).toBe(galleryLine.data[0]?.[category]);
    }
    expect(line.meta.series.map((series) => series.id)).toEqual(
      wide.series.map((series) => series.id)
    );
    expect(donut.data).toEqual(createGalleryState("tremor", "donut").adapterModel.data);
    expect(barList.data).toEqual(createGalleryState("tremor", "barList").adapterModel.data);
  });

  it("backs the Recharts gallery examples with implemented row and dataKey adapters", () => {
    const result = createEngineResult();
    const wide = toEngineWideTableModel(result, { seriesLabel: gallerySeriesLabel });
    const model = toRechartsEngineTimeSeriesModel(wide, { unit: "ms" });
    const galleryLine = createGalleryState("recharts", "line").adapterModel;

    expect(model.xAxisKey).toBe(galleryLine.xAxisKey);
    expect(model.tooltipKey).toBe(galleryLine.tooltipKey);
    expect(model.series).toEqual(galleryLine.series);
    expect(model.data).toEqual(galleryLine.data);
  });
});

function gallerySeriesLabel(series) {
  return [
    series.labels.get("service") ?? "service",
    series.labels.get("route") ?? "route",
    series.labels.get("status_class") ?? "status",
  ].join(" ");
}
