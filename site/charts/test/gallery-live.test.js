import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIVE_REFRESH_RATE_ID,
  getLiveRefreshRate,
  LIVE_REFRESH_RATES,
} from "../js/gallery-live.js";

describe("chart gallery live refresh rates", () => {
  it("offers slow, fast, and ultra-fast refresh presets", () => {
    expect(LIVE_REFRESH_RATES.map((rate) => rate.label)).toEqual([
      "1 Hz",
      "4 Hz",
      "10 Hz",
      "30 Hz",
      "60 Hz",
    ]);
    expect(LIVE_REFRESH_RATES.at(-1)?.intervalMs).toBe(16);
  });

  it("defaults to a fast but survivable live update cadence", () => {
    expect(DEFAULT_LIVE_REFRESH_RATE_ID).toBe("100");
    expect(getLiveRefreshRate(undefined).label).toBe("10 Hz");
    expect(getLiveRefreshRate("16").label).toBe("60 Hz");
  });
});
