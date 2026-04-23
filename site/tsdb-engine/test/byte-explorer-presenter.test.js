import { describe, expect, it } from "vitest";
import {
  buildByteTooltipHTML,
  buildEmptyDecodeHTML,
  buildEntryDecodeHTML,
  buildRegionDecodeHTML,
  formatDecodedValue,
  formatNsDuration,
} from "../js/byte-explorer-presenter.js";

describe("byte-explorer-presenter", () => {
  it("formats nanosecond durations in readable units", () => {
    expect(formatNsDuration(15_000_000_000n)).toBe("15s");
    expect(formatNsDuration(500_000n)).toBe("500000 ns");
    expect(formatNsDuration(-1_000_000_000n)).toBe("-1s");
  });

  it("formats decoded numeric values without trailing noise", () => {
    expect(formatDecodedValue(42)).toBe("42");
    expect(formatDecodedValue(42.5)).toBe("42.5");
    expect(formatDecodedValue(0.0001234)).toContain("0.0001234".slice(0, 6));
  });

  it("builds compact empty-state copy", () => {
    expect(buildEmptyDecodeHTML("byte")).toContain("Select a value byte");
    expect(buildEmptyDecodeHTML("timestamp")).toContain("Select a timestamp byte");
  });

  it("renders plain-English ALP sample explanations", () => {
    const html = buildEntryDecodeHTML(
      {
        type: "value",
        encoding: "alp-bitpacked",
        sampleIndex: 210,
        decoded: 81,
        startBit: 0,
        endBit: 7,
        exponent: 0,
        minInt: 63n,
        offset: 18,
        bitWidth: 7,
      },
      "7 bits across 1 byte"
    );

    expect(html).toContain("Sample #210 value is 81");
    expect(html).toContain("ALP uses 63 as the chunk's starting value");
    expect(html).toContain("stores the difference: 18");
    expect(html).toContain("fits in 7 bits");
  });

  it("renders compact exception sample explanations", () => {
    const html = buildEntryDecodeHTML(
      {
        type: "value",
        encoding: "alp-exception",
        sampleIndex: 210,
        decoded: 81,
        startBit: 0,
        endBit: 64,
      },
      "64 bits across 8 bytes"
    );

    expect(html).toContain("Sample #210 value is 81");
    expect(html).toContain("64 bits across 8 bytes");
    expect(html).toContain("did not fit the packed offset stream cleanly");
    expect(html).toContain("uses the full 64-bit value here");
  });

  it("renders plain-English timestamp explanations", () => {
    const html = buildEntryDecodeHTML(
      {
        type: "timestamp",
        encoding: "dod-zero",
        sampleIndex: 1,
        decoded: 1_715_000_010_000_000_000n,
        startBit: 0,
        endBit: 1,
        prevTs: 1_715_000_000_000_000_000n,
        prevDelta: 10_000_000_000n,
        delta: 10_000_000_000n,
        dod: 0n,
      },
      "1 bit"
    );

    expect(html).toContain("Sample #1");
    expect(html).toContain("datapoints arriving every 10s");
    expect(html).toContain("timestamp only needs 1 bit");
    expect(html).toContain("tiny repeat marker");
  });

  it("renders region explanations as escaped note blocks", () => {
    const html = buildRegionDecodeHTML({
      name: "ALP Header",
      start: 0,
      end: 14,
      decode() {
        return "Line 1\n\nLine 2 <tag>";
      },
    });

    expect(html).toContain("ALP Header");
    expect(html).toContain("bytes 0-13");
    expect(html).toContain("Line 1");
    expect(html).toContain("&lt;tag&gt;");
  });

  it("renders compact tooltip copy for mapped sample bytes", () => {
    const html = buildByteTooltipHTML({
      offset: 14,
      value: "00",
      mode: "hex",
      regionName: "Offsets",
      entry: {
        type: "value",
        encoding: "alp-bitpacked",
        sampleIndex: 107,
        decoded: 2905,
        offset: 48,
        exponent: 0,
        minInt: 2857n,
        bitWidth: 12,
        startBit: 0,
        endBit: 12,
      },
    });

    expect(html).toContain("Sample #107 value is 2905");
    expect(html).toContain("chunk baseline is 2857");
    expect(html).toContain("difference of 48");
    expect(html).toContain("12 bits");
  });

  it("renders minimal tooltip copy for unmapped bytes", () => {
    const html = buildByteTooltipHTML({
      offset: 3,
      value: "3C",
      mode: "hex",
      regionName: "ALP Header",
      entry: null,
    });

    expect(html).toContain("ALP Header");
    expect(html).toContain("Byte 3 is shown here as 0x3C");
  });
});
