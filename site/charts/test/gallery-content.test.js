import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("chart gallery content", () => {
  it("keeps user docs honest about shipped adapters", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

    expect(html).toContain("most polished adapters today are Tremor and Recharts");
    expect(html).toContain("toEngineWideTableModel");
    expect(html).toContain("toEngineLatestValueModel");
    expect(html).toContain("toEngineLineSeriesModel");
    expect(html).toContain("Show code button");
    expect(html).toContain("package-rendered chart");
    expect(html).toContain("Compared with raw data sources");
    expect(html).toContain("engine model -> library-native output");
    expect(html).toContain('id="chartGallery"');
    expect(html).not.toContain('id="chartButtons"');
    expect(html).not.toContain('id="codeBlock"');
    expect(html).not.toContain("toEChartsOption(wide)");
  });
});
