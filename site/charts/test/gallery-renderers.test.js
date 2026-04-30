import { describe, expect, it } from "vitest";

import { hasPackageRenderer } from "../js/gallery-renderers.js";

describe("chart gallery package renderers", () => {
  it("marks every browser-mounted chart package as package-backed", () => {
    expect(
      [
        "tremor",
        "recharts",
        "chartjs",
        "echarts",
        "uplot",
        "plotly",
        "apexcharts",
        "highcharts",
        "vegalite",
        "nivo",
        "observable",
        "victory",
        "agcharts",
      ].filter(hasPackageRenderer)
    ).toHaveLength(13);
  });

  it("keeps adapter-shape-only libraries out of the package-rendered set", () => {
    expect(hasPackageRenderer("visx")).toBe(false);
  });
});
