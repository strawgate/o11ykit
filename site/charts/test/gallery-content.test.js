import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("chart gallery content", () => {
  it("keeps user docs honest about shipped and planned adapters", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

    expect(html).toContain("copy-ready adapters today are Tremor and Recharts");
    expect(html).toContain("toEngineWideTableModel");
    expect(html).toContain("toEngineLatestValueModel");
    expect(html).toContain("toEngineLineSeriesModel");
    expect(html).not.toContain("toEChartsOption(wide)");
  });
});
