import { renderBitView } from "./byte-explorer-bit-view.js";
import { highlightExplorerEntry } from "./byte-explorer-highlight.js";
import { entryByteRange, renderHexRowHTML } from "./byte-explorer-logic.js";
import { buildByteTooltipHTML } from "./byte-explorer-presenter.js";
import { formatHexByte } from "./utils.js";

const HEX_COLS = 32;
const MAX_INITIAL_ROWS = 100;
const SCROLL_THRESHOLD = 200;

export function renderHexContent({
  gridEl,
  scrollContainer,
  bytes,
  byteRegion,
  regions,
  byteLookup,
  totalRows,
  viewport,
}) {
  const minimap = viewport?.parentElement || null;
  const gridLayout = scrollContainer.closest(".byte-grid-layout");
  const scrollHint = gridLayout?.querySelector(".hex-scroll-hint") || null;
  const state = {
    cellsByOffset: {},
    renderedRows: 0,
    currentMode: "hex",
    sentinel: null,
  };

  function renderBatch(startRow, count, mode) {
    const htmlParts = [];
    for (let r = startRow; r < startRow + count; r++) {
      htmlParts.push(renderHexRowHTML(r, HEX_COLS, bytes, byteRegion, regions, mode, byteLookup));
    }
    return htmlParts.join("");
  }

  function indexCells() {
    state.cellsByOffset = {};
    const cells = gridEl.querySelectorAll(".hex-cell[data-offset]");
    for (let i = 0; i < cells.length; i++) {
      state.cellsByOffset[cells[i].dataset.offset] = cells[i];
    }
  }

  function syncScrollChrome() {
    const maxVisibleHeight = 320;
    const contentHeight = Math.min(maxVisibleHeight, Math.max(72, gridEl.scrollHeight || 0));
    if (minimap) minimap.style.height = `${contentHeight}px`;

    const hasVerticalOverflow = scrollContainer.scrollHeight - scrollContainer.clientHeight > 4;
    const hasHorizontalOverflow = scrollContainer.scrollWidth - scrollContainer.clientWidth > 4;
    const isScrollable = hasVerticalOverflow || hasHorizontalOverflow;
    const isAtEnd =
      scrollContainer.scrollTop + scrollContainer.clientHeight >=
        scrollContainer.scrollHeight - 4 &&
      scrollContainer.scrollLeft + scrollContainer.clientWidth >= scrollContainer.scrollWidth - 4;

    scrollContainer.classList.toggle("is-scrollable", isScrollable);
    scrollContainer.classList.toggle("is-at-end", isAtEnd);
    if (scrollHint) scrollHint.classList.toggle("visible", isScrollable && !isAtEnd);
  }

  const initialRows = Math.min(totalRows, MAX_INITIAL_ROWS);
  gridEl.innerHTML = renderBatch(0, initialRows, "hex");
  indexCells();
  state.renderedRows = initialRows;

  if (totalRows > initialRows) {
    state.sentinel = document.createElement("div");
    state.sentinel.style.height = "1px";
    state.sentinel.style.gridColumn = "1 / -1";
    gridEl.appendChild(state.sentinel);
  }

  let scrollRAF = 0;
  scrollContainer.addEventListener("scroll", () => {
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(() => {
      scrollRAF = 0;

      const scrollFraction =
        scrollContainer.scrollTop /
        Math.max(1, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      const vf = scrollContainer.clientHeight / Math.max(1, scrollContainer.scrollHeight);
      viewport.style.top = `${scrollFraction * (1 - vf) * 100}%`;
      viewport.style.height = `${Math.max(3, vf * 100)}%`;
      syncScrollChrome();

      if (state.renderedRows < totalRows && state.sentinel && state.sentinel.parentNode) {
        const sRect = state.sentinel.getBoundingClientRect();
        const cRect = scrollContainer.getBoundingClientRect();
        if (sRect.top < cRect.bottom + SCROLL_THRESHOLD) {
          const batch = Math.min(50, totalRows - state.renderedRows);
          gridEl.removeChild(state.sentinel);
          gridEl.insertAdjacentHTML(
            "beforeend",
            renderBatch(state.renderedRows, batch, state.currentMode)
          );
          const newCells = gridEl.querySelectorAll(".hex-cell[data-offset]");
          for (let i = 0; i < newCells.length; i++) {
            const off = newCells[i].dataset.offset;
            if (!state.cellsByOffset[off]) state.cellsByOffset[off] = newCells[i];
          }
          state.renderedRows += batch;
          if (state.renderedRows < totalRows) gridEl.appendChild(state.sentinel);
        }
      }
    });
  });

  const initVF = scrollContainer.clientHeight / Math.max(1, scrollContainer.scrollHeight);
  viewport.style.top = "0%";
  viewport.style.height = `${Math.max(3, initVF * 100)}%`;
  syncScrollChrome();

  function rerender(mode) {
    state.currentMode = mode;
    state.renderedRows = Math.min(totalRows, MAX_INITIAL_ROWS);
    gridEl.innerHTML = renderBatch(0, state.renderedRows, mode);
    indexCells();
    if (state.renderedRows < totalRows) {
      if (!state.sentinel) {
        state.sentinel = document.createElement("div");
        state.sentinel.style.height = "1px";
        state.sentinel.style.gridColumn = "1 / -1";
      }
      gridEl.appendChild(state.sentinel);
    }
    requestAnimationFrame(syncScrollChrome);
  }

  return { state, grid: gridEl, scrollContainer, rerender };
}

export function setupHexInteraction({
  explorer,
  bytes,
  byteRegion,
  regions,
  byteLookup,
  hexContent,
  showRegionDetail,
  setEscapeHandler,
}) {
  const grid = hexContent.grid;
  const hexDecodePanel = explorer.querySelector(".hex-decode-panel");
  let lastTapOffset = null;
  let lastTapAt = 0;

  function resolveHexCell(target, event) {
    const baseTarget = target?.nodeType === Node.TEXT_NODE ? target.parentElement : target;
    const directCell = baseTarget?.closest ? baseTarget.closest(".hex-cell") : baseTarget;
    if (directCell?.classList?.contains("hex-cell")) return directCell;

    if (event?.type !== "touchend") return null;

    const points = [];
    if (event?.changedTouches?.length) {
      for (let i = 0; i < event.changedTouches.length; i++) {
        points.push({ x: event.changedTouches[i].clientX, y: event.changedTouches[i].clientY });
      }
    }
    for (let pi = 0; pi < points.length; pi++) {
      const hit = document.elementFromPoint(points[pi].x, points[pi].y);
      const hitCell = hit?.closest ? hit.closest(".hex-cell") : hit;
      if (hitCell?.classList?.contains("hex-cell")) return hitCell;
    }
    return null;
  }

  function highlightHexSample(entry) {
    highlightExplorerEntry({
      entry,
      decodePanel: hexDecodePanel,
      emptyKind: hexDecodePanel.id === "hexDecodePanelTs" ? "timestamp" : "byte",
      clearHighlights() {
        if (highlightHexSample._prev) {
          highlightHexSample._prev.forEach((cell) => {
            cell.classList.remove("hex-highlight", "hex-highlight-ts", "hex-highlight-val");
          });
          highlightHexSample._prev = null;
        }
      },
      applyHighlight(e) {
        const range = entryByteRange(e, bytes.length);
        const highlighted = [];
        for (let bi = range.startByte; bi < range.endByte; bi++) {
          const cell = hexContent.state.cellsByOffset[bi];
          if (cell) {
            cell.classList.add("hex-highlight");
            cell.classList.add(e.type === "timestamp" ? "hex-highlight-ts" : "hex-highlight-val");
            highlighted.push(cell);
          }
        }
        highlightHexSample._prev = highlighted;
        const bits = e.endBit - e.startBit;
        const spanBytes = range.endByte - range.startByte;
        return `${bits} bits across ${spanBytes} byte${spanBytes !== 1 ? "s" : ""} (byte ${range.startByte}\u2013${range.endByte - 1})`;
      },
      setActiveEntry() {},
    });
  }

  let tooltip = document.querySelector(".byte-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "byte-tooltip";
    document.body.appendChild(tooltip);
  }
  let lastTooltipOffset = -1;

  grid.addEventListener("mouseover", (e) => {
    const cell = e.target;
    if (!cell.classList?.contains("hex-cell")) {
      tooltip.classList.remove("visible");
      lastTooltipOffset = -1;
      return;
    }
    const offset = cell.dataset.offset | 0;
    if (offset === lastTooltipOffset) return;
    lastTooltipOffset = offset;
    const val = bytes[offset];
    const rIdx = byteRegion[offset];
    const region = regions[rIdx];
    tooltip.innerHTML = buildByteTooltipHTML({
      offset,
      value: hexContent.state.currentMode === "hex" ? formatHexByte(val) : `${val}`,
      mode: hexContent.state.currentMode,
      regionName: region.name,
      entry: byteLookup?.[offset],
    });
    tooltip.classList.add("visible");
  });

  let moveRAF = 0;
  grid.addEventListener("mousemove", (e) => {
    if (moveRAF) return;
    moveRAF = requestAnimationFrame(() => {
      moveRAF = 0;
      tooltip.style.left = `${e.clientX + 12}px`;
      tooltip.style.top = `${e.clientY - 40}px`;
    });
  });

  grid.addEventListener("mouseleave", () => {
    tooltip.classList.remove("visible");
    lastTooltipOffset = -1;
  });

  function handleCellSelection(target, event) {
    const cell = resolveHexCell(target, event);
    if (!cell?.classList?.contains("hex-cell")) return;
    const offset = cell.dataset.offset | 0;

    if (byteLookup?.[offset]) {
      highlightHexSample(byteLookup[offset]);
      return;
    }

    highlightHexSample(null);
    const rIdx = byteRegion[offset];
    showRegionDetail(regions[rIdx]);
  }

  function shouldSkipDuplicate(offset) {
    const now = Date.now();
    if (lastTapOffset === offset && now - lastTapAt < 250) return true;
    lastTapOffset = offset;
    lastTapAt = now;
    return false;
  }

  grid.addEventListener(
    "touchend",
    (e) => {
      const cell = resolveHexCell(e.target, e);
      if (!cell?.classList?.contains("hex-cell")) return;
      const offset = cell.dataset.offset | 0;
      if (shouldSkipDuplicate(offset)) return;
      e.preventDefault();
      handleCellSelection(cell, e);
    },
    { passive: false }
  );

  grid.addEventListener("pointerup", (e) => {
    if (e.pointerType === "touch") return;
    const cell = resolveHexCell(e.target, e);
    if (!cell?.classList?.contains("hex-cell")) return;
    const offset = cell.dataset.offset | 0;
    if (shouldSkipDuplicate(offset)) return;
    handleCellSelection(cell, e);
  });

  setEscapeHandler((e) => {
    if (e.key === "Escape") highlightHexSample(null);
  });

  return highlightHexSample;
}

export function setupViewModeButtons({
  explorer,
  bytes,
  regions,
  bitMap,
  hexContent,
  highlightHexSample,
}) {
  const hexDecodePanel = explorer.querySelector(".hex-decode-panel");
  const buttons = explorer.querySelectorAll(".byte-explorer-controls button");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      const mode = btn.dataset.view;

      if (mode === "bits") {
        hexDecodePanel.style.display = "none";
        renderBitView(explorer, bytes, regions, bitMap);
      } else {
        const bitView = explorer.querySelector(".bit-view");
        if (bitView) bitView.remove();
        const dp = explorer.querySelector(".bit-decode-panel");
        if (dp) dp.remove();
        highlightHexSample(null);
        hexContent.scrollContainer.style.display = "";
        hexContent.rerender(mode);
      }
    });
  });
}
