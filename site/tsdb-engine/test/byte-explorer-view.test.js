import { describe, expect, it } from "vitest";
import { buildExplorerShellHTML, getRegionSwatchColor } from "../js/byte-explorer-view.js";

describe("byte-explorer-view", () => {
  it("builds the shared explorer shell html", () => {
    const html = buildExplorerShellHTML({
      title: "Timestamp Explorer",
      bytesLength: 99,
      minimapId: "byteMinimapTs",
      gridId: "hexGridTs",
      decodePanelId: "hexDecodePanelTs",
      emptyKind: "timestamp",
    });

    expect(html).toContain("Timestamp Explorer");
    expect(html).toContain('id="byteMinimapTs"');
    expect(html).toContain('id="hexGridTs"');
    expect(html).toContain("Select a timestamp byte");
    expect(html).toContain(">Hex<");
    expect(html).toContain(">Bits<");
  });

  it("maps region classes to stable swatch colors", () => {
    expect(getRegionSwatchColor({ cls: "header" })).toBe("#8b5cf6");
    expect(getRegionSwatchColor({ cls: "timestamps" })).toBe("#06b6d4");
    expect(getRegionSwatchColor({ cls: "exceptions" })).toBe("#f59e0b");
    expect(getRegionSwatchColor({ cls: "values" })).toBe("#10b981");
  });
});
