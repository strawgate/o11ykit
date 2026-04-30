import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("chart gallery content", () => {
  it("keeps user docs honest about shipped adapters", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

    expect(html).toContain("What the adapter gives you");
    expect(html).toContain("toTremorLineChartProps(result)");
    expect(html).toContain("toRechartsTimeSeriesData(result)");
    expect(html).not.toContain("toEngineWideTableModel(result)");
    expect(html).not.toContain("toEngineLatestValueModel(result)");
    expect(html).toContain("new ScanEngine");
    expect(html).not.toContain("new FlatStore");
    expect(html).toContain("Every gallery chart starts from");
    expect(html).toContain("Show code button");
    expect(html).toContain("native render code");
    expect(html).toContain('id="refreshRate"');
    expect(html).toContain("Refresh rate");
    expect(html).not.toContain('id="librarySummary"');
    expect(html).toContain("What you still control");
    expect(html).toContain("result -> published adapter -> native input");
    expect(html).toContain('id="chartGallery"');
    expect(html).not.toContain('id="chartButtons"');
    expect(html).not.toContain('id="codeBlock"');
    expect(html).not.toContain("toEChartsOption(wide)");
    expect(html.toLowerCase()).not.toContain("adapter-shape");
    expect(html.toLowerCase()).not.toContain("fake");
  });

  it("does not draw gallery-only graph lines behind native charts", async () => {
    const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toContain(".chart-card-frame");
    expect(css).toContain("background: var(--paper)");
    expect(css).not.toContain(".chart-grid-line");
    expect(css).not.toContain(".chart-preview");
    expect(css).not.toContain(".chart-axis");
    expect(css).not.toContain(".mini-legend");
    expect(css).not.toContain("linear-gradient(var(--chart-grid)");
  });
});
