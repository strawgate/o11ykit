// @ts-check

/** @typedef {import("../site-types").ByteRegion} ByteRegion */
/** @typedef {import("../site-types").ExplorerShellOptions} ExplorerShellOptions */

import { buildEmptyDecodeHTML } from "./byte-explorer-presenter.js";
import { formatBytes } from "./utils.js";

/**
 * @param {Pick<ByteRegion, "cls">} region
 * @returns {string}
 */
export function getRegionSwatchColor(region) {
  return region.cls === "header"
    ? "#8b5cf6"
    : region.cls === "timestamps"
      ? "#06b6d4"
      : region.cls === "exceptions"
        ? "#f59e0b"
        : "#10b981";
}

/**
 * @param {ExplorerShellOptions} options
 * @returns {string}
 */
export function buildExplorerShellHTML({
  title,
  bytesLength,
  minimapId,
  gridId,
  decodePanelId,
  emptyKind,
  insightHtml,
}) {
  return (
    '<div class="byte-explorer-header">' +
    `<h4>🔬 ${title} <span style="font-weight:400;color:#6b8a9e;font-size:11px">` +
    formatBytes(bytesLength) +
    " · " +
    bytesLength.toLocaleString() +
    " bytes</span></h4>" +
    '<div class="byte-explorer-controls">' +
    '<button type="button" class="active" data-view="hex">Hex</button>' +
    '<button type="button" data-view="bits">Bits</button>' +
    "</div>" +
    "</div>" +
    (insightHtml ? `<div class="byte-explorer-insight">${insightHtml}</div>` : "") +
    '<div class="byte-grid-layout">' +
    `<div class="byte-minimap" id="${minimapId}"></div>` +
    '<div class="hex-grid-scroll">' +
    `<div class="hex-grid" id="${gridId}" style="grid-template-columns: 48px repeat(32, 20px);"></div>` +
    "</div>" +
    '<div class="hex-scroll-hint" aria-hidden="true">Scroll to explore more bytes</div>' +
    "</div>" +
    `<div class="hex-decode-panel" id="${decodePanelId}">` +
    buildEmptyDecodeHTML(emptyKind) +
    "</div>"
  );
}

/**
 * @param {HTMLElement} explorer
 * @param {ExplorerShellOptions} options
 * @returns {void}
 */
export function mountExplorerShell(explorer, options) {
  explorer.innerHTML = buildExplorerShellHTML(options);
}

/**
 * @param {HTMLElement} minimap
 * @param {{
 *   totalBytes: number,
 *   regions: ByteRegion[],
 *   onRegionClick: (region: ByteRegion) => void,
 *   getColor: (region: ByteRegion) => string,
 * }} options
 * @returns {HTMLDivElement}
 */
export function renderMinimap(minimap, { totalBytes, regions, onRegionClick, getColor }) {
  regions.forEach((region) => {
    /** @type {HTMLDivElement} */
    var seg = document.createElement("div");
    seg.className = "mm-seg";
    seg.style.height = `${Math.max(1, ((region.end - region.start) / totalBytes) * 100)}%`;
    seg.style.background = getColor(region);
    seg.title = `${region.name}: ${formatBytes(region.end - region.start)}`;
    seg.addEventListener("click", () => onRegionClick(region));
    minimap.appendChild(seg);
  });

  /** @type {HTMLDivElement} */
  var viewport = document.createElement("div");
  viewport.className = "mm-viewport";
  minimap.appendChild(viewport);
  return viewport;
}
