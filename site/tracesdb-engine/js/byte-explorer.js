// @ts-nocheck
// ── Byte Explorer — Hex grid with color-coded regions ───────────────
import { el, formatHexByte } from "./utils.js";

const REGION_CSS_MAP = {
  Timestamps: "region-timestamps",
  Durations: "region-durations",
  "Trace IDs": "region-ids",
  "Span IDs": "region-ids",
  "Parent IDs": "region-ids",
  "Span Names": "region-names",
  Status: "region-status",
  Kind: "region-kind",
  Attributes: "region-attributes",
  Events: "region-events",
  Links: "region-links",
  "Bloom Filter": "region-bloom",
};

/**
 * Render a hex byte explorer into a container.
 * @param {HTMLElement} container
 * @param {{ bytes: Uint8Array, regions: Array, totalBytes?: number }} data
 */
export function renderByteExplorer(container, data) {
  const { bytes, regions, totalBytes } = data;
  if (bytes.length === 0) return;

  container.innerHTML = "";

  // Header
  const header = el(
    "div",
    { className: "byte-explorer-header" },
    el("h4", {}, "Byte Explorer"),
    totalBytes
      ? el(
          "span",
          { style: { fontSize: "12px", color: "var(--dark-muted)" } },
          `Showing ${bytes.length} of ${totalBytes} bytes`
        )
      : null
  );
  container.appendChild(header);

  // Legend
  const legend = el("div", { className: "byte-explorer-legend" });
  const shownRegions = new Set();
  for (const region of regions) {
    if (shownRegions.has(region.name)) continue;
    shownRegions.add(region.name);
    const cssClass = REGION_CSS_MAP[region.name] || "region-header";
    legend.appendChild(
      el(
        "span",
        { className: "byte-legend-item" },
        el("span", {
          className: `byte-legend-swatch hex-cell ${cssClass}`,
          style: { width: "10px", height: "10px", display: "inline-block", borderRadius: "2px" },
        }),
        region.name
      )
    );
  }
  container.appendChild(legend);

  // Build region lookup: byte offset → region name
  const regionLookup = new Array(bytes.length);
  for (const region of regions) {
    for (let i = region.start; i < region.end && i < bytes.length; i++) {
      regionLookup[i] = region.name;
    }
  }

  // Hex grid
  const grid = el("div", { className: "hex-grid" });
  const totalRows = Math.ceil(bytes.length / 16);
  const displayRows = Math.min(totalRows, 128);

  for (let row = 0; row < displayRows; row++) {
    const offset = row * 16;

    // Offset column
    grid.appendChild(
      el("span", { className: "hex-offset" }, `0x${offset.toString(16).padStart(4, "0")}`)
    );

    // 16 hex cells
    let asciiStr = "";
    for (let col = 0; col < 16; col++) {
      const idx = offset + col;
      if (idx < bytes.length) {
        const val = bytes[idx];
        const regionName = regionLookup[idx] || "";
        const cssClass = REGION_CSS_MAP[regionName] || "";
        const cell = el(
          "span",
          {
            className: `hex-cell ${cssClass}`,
            title: `Offset: 0x${idx.toString(16)} | Section: ${regionName || "unknown"} | Value: ${val}`,
          },
          formatHexByte(val)
        );
        grid.appendChild(cell);
        asciiStr += val >= 32 && val <= 126 ? String.fromCharCode(val) : "·";
      } else {
        grid.appendChild(el("span", { className: "hex-cell" }, "  "));
        asciiStr += " ";
      }
    }

    // ASCII column
    grid.appendChild(el("span", { className: "hex-ascii" }, asciiStr));
  }

  container.appendChild(grid);

  if (totalRows > displayRows) {
    container.appendChild(
      el(
        "div",
        {
          style: {
            textAlign: "center",
            padding: "8px",
            color: "var(--dark-muted)",
            fontSize: "12px",
          },
        },
        `… ${(totalRows - displayRows) * 16} more bytes`
      )
    );
  }
}
