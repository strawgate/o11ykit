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
      ].filter(hasPackageRenderer)
    ).toHaveLength(9);
  });

  it("keeps research-only libraries out of the package-rendered set", () => {
    expect(hasPackageRenderer("nivo")).toBe(false);
    expect(hasPackageRenderer("visx")).toBe(false);
    expect(hasPackageRenderer("agcharts")).toBe(false);
  });
});
