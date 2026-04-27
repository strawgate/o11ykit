import { describe, expect, it } from "vitest";
import {
  clamp,
  escapeHtml,
  formatBytes,
  formatDurationMs,
  formatDurationNs,
  formatNum,
  formatPercent,
  hexFromBytes,
  serviceColor,
  shortSpanId,
  shortTraceId,
  spanAttr,
  spanServiceName,
} from "../js/utils.js";

describe("escapeHtml", () => {
  it("escapes angle brackets and ampersands", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    );
  });

  it("passes through safe strings unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("coerces non-string values", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
  });
});

describe("formatNum", () => {
  it("formats small numbers as-is", () => {
    expect(formatNum(42)).toBe("42");
  });

  it("formats thousands with K suffix", () => {
    expect(formatNum(5_400)).toBe("5.4K");
  });

  it("formats millions with M suffix", () => {
    expect(formatNum(2_500_000)).toBe("2.5M");
  });
});

describe("formatDurationNs", () => {
  it("formats nanoseconds", () => {
    expect(formatDurationNs(500)).toBe("500ns");
  });

  it("formats microseconds", () => {
    expect(formatDurationNs(5_000)).toBe("5.0µs");
  });

  it("formats milliseconds", () => {
    expect(formatDurationNs(12_345_000)).toBe("12.3ms");
  });

  it("formats seconds", () => {
    expect(formatDurationNs(2_500_000_000)).toBe("2.50s");
  });
});

describe("formatDurationMs", () => {
  it("formats sub-second as ms", () => {
    expect(formatDurationMs(123.4)).toBe("123.4ms");
  });

  it("formats seconds", () => {
    expect(formatDurationMs(2500)).toBe("2.50s");
  });
});

describe("formatPercent", () => {
  it("formats large percentages without decimals", () => {
    expect(formatPercent(42)).toBe("42%");
  });

  it("formats medium percentages with one decimal", () => {
    expect(formatPercent(5.5)).toBe("5.5%");
  });

  it("formats small percentages with two decimals", () => {
    expect(formatPercent(0.07)).toBe("0.07%");
  });
});

describe("shortTraceId", () => {
  it("truncates a hex string to prefix…suffix", () => {
    const hex = "abcdef0123456789abcdef0123456789";
    expect(shortTraceId(hex)).toBe("abcdef01…6789");
  });

  it("works with Uint8Array input", () => {
    const buf = new Uint8Array([0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89]);
    const result = shortTraceId(buf);
    expect(result).toMatch(/^[0-9a-f]{8}…[0-9a-f]{4}$/);
  });
});

describe("shortSpanId", () => {
  it("returns first 8 hex chars", () => {
    expect(shortSpanId("abcdef0123456789")).toBe("abcdef01");
  });
});

describe("spanServiceName", () => {
  it("extracts service.name from attributes", () => {
    const span = { attributes: [{ key: "service.name", value: "gateway" }] };
    expect(spanServiceName(span)).toBe("gateway");
  });

  it('returns "unknown" when no attributes', () => {
    expect(spanServiceName({})).toBe("unknown");
  });

  it('returns "unknown" when service.name not present', () => {
    const span = { attributes: [{ key: "other", value: "val" }] };
    expect(spanServiceName(span)).toBe("unknown");
  });
});

describe("spanAttr", () => {
  it("returns attribute value by key", () => {
    const span = { attributes: [{ key: "http.method", value: "GET" }] };
    expect(spanAttr(span, "http.method")).toBe("GET");
  });

  it("returns undefined for missing key", () => {
    const span = { attributes: [{ key: "http.method", value: "GET" }] };
    expect(spanAttr(span, "missing")).toBeUndefined();
  });

  it("returns undefined when no attributes", () => {
    expect(spanAttr({}, "any")).toBeUndefined();
  });
});

describe("serviceColor", () => {
  it("returns a consistent color for the same name", () => {
    expect(serviceColor("gateway")).toBe(serviceColor("gateway"));
  });

  it("returns a hex color string", () => {
    expect(serviceColor("auth")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("clamp", () => {
  it("clamps below min", () => {
    expect(clamp(-5, 0, 100)).toBe(0);
  });

  it("clamps above max", () => {
    expect(clamp(200, 0, 100)).toBe(100);
  });

  it("passes through in-range values", () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });
});
