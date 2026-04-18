// ── Interactive Byte Explorer ──────────────────────────────────────

import {
  ALP_HEADER_SIZE,
  buildALPBitMap,
  buildALPInsightHtml,
  buildByteLookup,
  buildByteRegionMap,
  buildXORInsightHtml,
  encodingDescription,
  entryByteRange,
  parseALPHeader,
  parseXORHeader,
  renderHexRowHTML,
  TS_HEADER_SIZE,
} from "./byte-explorer-logic.js";
import { BitReader, decodeChunkAnnotated } from "./codec.js";
import { $, formatBytes, formatEpochNs, formatHexByte, readI64BE, superNum } from "./utils.js";

const HEX_COLS = 32;
const MAX_BITS = 2048;
const BITS_PER_ROW = 64;
const MAX_INITIAL_ROWS = 100;
const SCROLL_THRESHOLD = 200;

// ── Shared highlight helpers ─────────────────────────────────────────

function _buildDecodeHTML(entry, spanDesc) {
  var _bits = entry.endBit - entry.startBit;
  var decodedStr;
  if (entry.type === "timestamp") {
    decodedStr = formatEpochNs(entry.decoded);
  } else {
    decodedStr =
      typeof entry.decoded === "number" ? entry.decoded.toPrecision(8) : String(entry.decoded);
  }
  var enc = encodingDescription(entry);
  var typeIcon = entry.type === "timestamp" ? "\u23f1" : "\uD83D\uDCCA";
  var typeLabel = entry.type === "timestamp" ? "Timestamp" : "Value";

  return (
    '<div class="bdp-header">' +
    '<span class="bdp-type ' +
    entry.type +
    '">' +
    typeIcon +
    " " +
    typeLabel +
    "</span>" +
    '<span class="bdp-sample">Sample #' +
    entry.sampleIndex +
    "</span>" +
    '<span class="bdp-bits">' +
    spanDesc +
    "</span>" +
    "</div>" +
    '<div class="bdp-value">' +
    decodedStr +
    "</div>" +
    '<div class="bdp-encoding">' +
    enc +
    "</div>" +
    (entry.dod !== undefined
      ? '<div class="bdp-detail">\u0394\u00b2 = ' +
        entry.dod.toString() +
        ", \u0394 = " +
        entry.delta.toString() +
        "</div>"
      : "") +
    (entry.xor !== undefined && entry.xor !== 0n
      ? `<div class="bdp-detail">XOR = 0x${entry.xor.toString(16).padStart(16, "0")}</div>`
      : "")
  );
}

function _highlightEntry(entry, decodePanel, clearFn, applyFn, setActiveFn) {
  clearFn();
  if (!entry) {
    decodePanel.style.display = "none";
    setActiveFn(null);
    return;
  }
  setActiveFn(entry);
  var spanDesc = applyFn(entry);
  decodePanel.style.display = "";
  decodePanel.innerHTML = _buildDecodeHTML(entry, spanDesc);
}

// ── Bit View helpers ─────────────────────────────────────────────────

function _buildBitLookup(bitMap) {
  var bitLookup = {};
  if (bitMap) {
    for (var mi = 0; mi < bitMap.length; mi++) {
      var entry = bitMap[mi];
      var baseOffset = (entry.blobOffset || 0) * 8;
      for (var b = entry.startBit; b < entry.endBit; b++) {
        bitLookup[baseOffset + b] = entry;
      }
    }
  }
  return bitLookup;
}

function _renderBitGrid(container, bytes, regions, maxBits, bitLookup) {
  regions.forEach((region) => {
    var regionHeader = document.createElement("div");
    regionHeader.style.cssText = "margin:6px 0 4px;font-weight:700;font-size:11px;color:#f59e0b;";
    regionHeader.textContent =
      "\u2500\u2500 " +
      region.name +
      " (bytes " +
      region.start +
      "\u2013" +
      (region.end - 1) +
      ") \u2500\u2500";
    container.appendChild(regionHeader);

    var regionBytes = bytes.slice(region.start, Math.min(region.end, Math.ceil(maxBits / 8)));
    var bitsPerRow = BITS_PER_ROW;
    var prevEntry = null;

    for (var rowStart = 0; rowStart < regionBytes.length * 8; rowStart += bitsPerRow) {
      var rowEl = document.createElement("div");
      rowEl.className = "bit-row";

      var label = document.createElement("span");
      label.className = "bit-sample-label";
      label.textContent = `b${region.start * 8 + rowStart}`;
      rowEl.appendChild(label);

      var rowEnd = Math.min(rowStart + bitsPerRow, regionBytes.length * 8);
      for (var b = rowStart; b < rowEnd; b++) {
        var byteOff = Math.floor(b / 8);
        var bitOff = 7 - (b % 8);
        var bitVal = (regionBytes[byteOff] >> bitOff) & 1;

        var globalBitIdx = region.start * 8 + b;
        var bitEl = document.createElement("span");
        bitEl.className = `bit ${bitVal ? "b1" : "b0"}`;
        bitEl.textContent = bitVal;
        bitEl.dataset.bit = globalBitIdx;

        // Check if this bit belongs to a mapped sample
        var mapEntry = bitLookup[globalBitIdx];
        if (mapEntry) {
          bitEl.classList.add("bit-mapped");
          bitEl.classList.add(mapEntry.type === "timestamp" ? "bit-ts" : "bit-val");
          // Alternating sample shade
          bitEl.classList.add(
            mapEntry.sampleIndex % 2 === 0 ? "bit-sample-even" : "bit-sample-odd"
          );
          // Boundary: first bit of a new encoding entry
          if (mapEntry !== prevEntry && prevEntry !== null) {
            bitEl.classList.add("bit-boundary");
          }
          // First mapped bit of the region also gets a boundary
          if (prevEntry === null) {
            bitEl.classList.add("bit-boundary");
          }
          bitEl.title =
            (mapEntry.type === "timestamp" ? "\u23f1 " : "\uD83D\uDCCA ") +
            "Sample #" +
            mapEntry.sampleIndex;
          prevEntry = mapEntry;
        }

        rowEl.appendChild(bitEl);

        if ((b + 1) % 8 === 0 && b + 1 < rowEnd) {
          var sep = document.createElement("span");
          sep.style.cssText = "width:4px;";
          rowEl.appendChild(sep);
        }
      }

      container.appendChild(rowEl);
    }

    if (region.end * 8 > maxBits) return;
  });

  if (bytes.length * 8 > maxBits) {
    var note = document.createElement("div");
    note.style.cssText = "margin-top:8px;color:#94a3b8;font-size:10px;";
    note.textContent = `Showing first ${maxBits} of ${bytes.length * 8} bits...`;
    container.appendChild(note);
  }
}

function _setupBitInteraction(container, bitLookup, explorer) {
  var decodePanel = document.createElement("div");
  decodePanel.className = "bit-decode-panel";
  decodePanel.style.display = "none";

  var _activeEntry = null;

  function highlightBitRange(entry) {
    _highlightEntry(
      entry,
      decodePanel,
      () => {
        container.querySelectorAll(".bit.bit-highlight").forEach((el) => {
          el.classList.remove("bit-highlight", "bit-highlight-ts", "bit-highlight-val");
        });
      },
      (e) => {
        var baseOffset = (e.blobOffset || 0) * 8;
        for (var b = e.startBit; b < e.endBit; b++) {
          var globalBit = baseOffset + b;
          var el = container.querySelector(`.bit[data-bit="${globalBit}"]`);
          if (el) {
            el.classList.add("bit-highlight");
            el.classList.add(e.type === "timestamp" ? "bit-highlight-ts" : "bit-highlight-val");
          }
        }
        var bits = e.endBit - e.startBit;
        return `${bits} bits (bit ${e.startBit}\u2013${e.endBit - 1})`;
      },
      (v) => {
        _activeEntry = v;
      }
    );
  }

  // Click handler for bits
  container.addEventListener("click", (e) => {
    var bitEl = e.target.closest(".bit-mapped");
    if (!bitEl) {
      highlightBitRange(null);
      return;
    }
    var globalBit = parseInt(bitEl.dataset.bit, 10);
    var entry = bitLookup[globalBit];
    if (entry) {
      highlightBitRange(entry);
    }
  });

  // Hover handler
  container.addEventListener("mouseover", (e) => {
    var bitEl = e.target.closest(".bit-mapped");
    if (bitEl) {
      bitEl.classList.add("bit-hover");
    }
  });
  container.addEventListener("mouseout", (e) => {
    var bitEl = e.target.closest(".bit-mapped");
    if (bitEl) {
      bitEl.classList.remove("bit-hover");
    }
  });

  // Escape to clear
  function onKeyDown(e) {
    if (e.key === "Escape") {
      highlightBitRange(null);
    }
  }
  document.addEventListener("keydown", onKeyDown);

  explorer.querySelector("#regionDetail").before(decodePanel);
  explorer.querySelector("#regionDetail").before(container);
}

// ── Interactive Bit View ─────────────────────────────────────────────

function renderBitView(explorer, bytes, _byteRegion, regions, _sampleCount, _codec, bitMap) {
  var scrollContainer = explorer.querySelector(".hex-grid-scroll");
  scrollContainer.style.display = "none";

  var existing = explorer.querySelector(".bit-view");
  if (existing) existing.remove();

  var container = document.createElement("div");
  container.className = "bit-view";

  var maxBits = Math.min(bytes.length * 8, MAX_BITS);
  var bitLookup = _buildBitLookup(bitMap);

  _renderBitGrid(container, bytes, regions, maxBits, bitLookup);
  _setupBitInteraction(container, bitLookup, explorer);
}

// ── Explorer shell helpers ───────────────────────────────────────────

function _buildExplorerShell(explorer, bytes, insightHtml) {
  var viewId = `hexView-${Date.now()}`;
  explorer.innerHTML =
    '<div class="byte-explorer-header">' +
    '<h4>\uD83D\uDD2C Byte Explorer <span style="font-weight:400;color:#6b8a9e;font-size:11px">' +
    formatBytes(bytes.length) +
    " \u00b7 " +
    bytes.length.toLocaleString() +
    " bytes</span></h4>" +
    '<div class="byte-explorer-controls">' +
    '<button class="active" data-view="hex">Hex</button>' +
    '<button data-view="decimal">Dec</button>' +
    '<button data-view="bits">Bits</button>' +
    "</div>" +
    "</div>" +
    '<div id="codecInsight">' +
    insightHtml +
    "</div>" +
    '<div class="byte-minimap" id="byteMinimap"></div>' +
    '<div class="hex-grid-scroll" id="' +
    viewId +
    '">' +
    '<div class="hex-grid" id="hexGrid" style="grid-template-columns: 56px repeat(' +
    HEX_COLS +
    ', minmax(0, 1fr)) minmax(0, 220px);"></div>' +
    "</div>" +
    '<div class="hex-decode-panel" id="hexDecodePanel" style="display:none"></div>' +
    '<div id="regionDetail"></div>';
}

function _buildMinimap(explorer, bytes, regions, showRegionDetail) {
  var minimap = explorer.querySelector("#byteMinimap");
  var totalLen = bytes.length;
  regions.forEach((r) => {
    var seg = document.createElement("div");
    seg.className = "mm-seg";
    seg.style.width = `${Math.max(1, ((r.end - r.start) / totalLen) * 100)}%`;
    seg.style.background =
      r.cls === "header"
        ? "#8b5cf6"
        : r.cls === "timestamps"
          ? "#06b6d4"
          : r.cls === "exceptions"
            ? "#f59e0b"
            : "#10b981";
    seg.title = `${r.name}: ${formatBytes(r.end - r.start)}`;
    seg.addEventListener("click", () => {
      var targetRow = Math.floor(r.start / HEX_COLS);
      var gridEl = explorer.querySelector(".hex-grid-scroll");
      var rowEls = gridEl.querySelectorAll(".hex-offset");
      if (rowEls[targetRow])
        rowEls[targetRow].scrollIntoView({ behavior: "smooth", block: "start" });
      showRegionDetail(r);
    });
    minimap.appendChild(seg);
  });

  // Viewport indicator
  var viewport = document.createElement("div");
  viewport.className = "mm-viewport";
  minimap.appendChild(viewport);
  return viewport;
}

function _renderHexContent(
  gridEl,
  scrollContainer,
  bytes,
  byteRegion,
  regions,
  byteLookup,
  totalRows,
  viewport
) {
  var state = {
    cellsByOffset: {},
    renderedRows: 0,
    currentMode: "hex",
    sentinel: null,
  };

  function renderBatch(startRow, count, mode) {
    var htmlParts = [];
    for (var r = startRow; r < startRow + count; r++) {
      htmlParts.push(renderHexRowHTML(r, HEX_COLS, bytes, byteRegion, regions, mode, byteLookup));
    }
    return htmlParts.join("");
  }

  function indexCells() {
    state.cellsByOffset = {};
    var cells = gridEl.querySelectorAll(".hex-cell[data-offset]");
    for (var i = 0; i < cells.length; i++) {
      state.cellsByOffset[cells[i].dataset.offset] = cells[i];
    }
  }

  var initialRows = Math.min(totalRows, MAX_INITIAL_ROWS);
  gridEl.innerHTML = renderBatch(0, initialRows, "hex");
  indexCells();
  state.renderedRows = initialRows;

  // Lazy render remaining rows
  if (totalRows > initialRows) {
    state.sentinel = document.createElement("div");
    state.sentinel.style.height = "1px";
    state.sentinel.style.gridColumn = "1 / -1";
    gridEl.appendChild(state.sentinel);
  }

  // Throttled scroll handler (combines lazy-load + viewport indicator)
  var scrollRAF = 0;
  scrollContainer.addEventListener("scroll", () => {
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(() => {
      scrollRAF = 0;

      // Viewport indicator
      var scrollFraction =
        scrollContainer.scrollTop /
        Math.max(1, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      var vf = scrollContainer.clientHeight / Math.max(1, scrollContainer.scrollHeight);
      viewport.style.left = `${scrollFraction * (1 - vf) * 100}%`;
      viewport.style.width = `${Math.max(3, vf * 100)}%`;

      // Lazy load
      if (state.renderedRows < totalRows && state.sentinel && state.sentinel.parentNode) {
        var sRect = state.sentinel.getBoundingClientRect();
        var cRect = scrollContainer.getBoundingClientRect();
        if (sRect.top < cRect.bottom + SCROLL_THRESHOLD) {
          var batch = Math.min(50, totalRows - state.renderedRows);
          gridEl.removeChild(state.sentinel);
          gridEl.insertAdjacentHTML(
            "beforeend",
            renderBatch(state.renderedRows, batch, state.currentMode)
          );
          // Index new cells
          var newCells = gridEl.querySelectorAll(".hex-cell[data-offset]");
          for (var i = 0; i < newCells.length; i++) {
            var off = newCells[i].dataset.offset;
            if (!state.cellsByOffset[off]) state.cellsByOffset[off] = newCells[i];
          }
          state.renderedRows += batch;
          if (state.renderedRows < totalRows) gridEl.appendChild(state.sentinel);
        }
      }
    });
  });

  var initVF = scrollContainer.clientHeight / Math.max(1, scrollContainer.scrollHeight);
  viewport.style.left = "0%";
  viewport.style.width = `${Math.max(3, initVF * 100)}%`;

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
  }

  return { state: state, grid: gridEl, scrollContainer: scrollContainer, rerender: rerender };
}

function _setupHexInteraction(
  explorer,
  bytes,
  byteRegion,
  regions,
  byteLookup,
  hexContent,
  showRegionDetail
) {
  var grid = hexContent.grid;
  var hexDecodePanel = explorer.querySelector(".hex-decode-panel");
  var _activeHexEntry = null;

  function highlightHexSample(entry) {
    _highlightEntry(
      entry,
      hexDecodePanel,
      () => {
        if (highlightHexSample._prev) {
          highlightHexSample._prev.forEach((c) => {
            c.classList.remove("hex-highlight", "hex-highlight-ts", "hex-highlight-val");
          });
          highlightHexSample._prev = null;
        }
      },
      (e) => {
        var range = entryByteRange(e, bytes.length);
        var highlighted = [];
        for (var bi = range.startByte; bi < range.endByte; bi++) {
          var cell = hexContent.state.cellsByOffset[bi];
          if (cell) {
            cell.classList.add("hex-highlight");
            cell.classList.add(e.type === "timestamp" ? "hex-highlight-ts" : "hex-highlight-val");
            highlighted.push(cell);
          }
        }
        highlightHexSample._prev = highlighted;
        var bits = e.endBit - e.startBit;
        var spanBytes = range.endByte - range.startByte;
        return (
          bits +
          " bits across " +
          spanBytes +
          " byte" +
          (spanBytes !== 1 ? "s" : "") +
          " (byte " +
          range.startByte +
          "\u2013" +
          (range.endByte - 1) +
          ")"
        );
      },
      (v) => {
        _activeHexEntry = v;
      }
    );
  }

  // Tooltip — pre-build structure, update via textContent where possible
  var tooltip = document.querySelector(".byte-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "byte-tooltip";
    document.body.appendChild(tooltip);
  }
  var lastTooltipOffset = -1;

  grid.addEventListener("mouseover", (e) => {
    var cell = e.target;
    if (!cell.classList?.contains("hex-cell")) {
      tooltip.classList.remove("visible");
      lastTooltipOffset = -1;
      return;
    }
    var offset = cell.dataset.offset | 0;
    if (offset === lastTooltipOffset) return;
    lastTooltipOffset = offset;
    var val = bytes[offset];
    var rIdx = byteRegion[offset];
    var region = regions[rIdx];
    var sampleInfo = "";
    if (byteLookup?.[offset]) {
      var blE = byteLookup[offset];
      sampleInfo =
        '<span class="bt-sample ' +
        blE.type +
        '">' +
        (blE.type === "timestamp" ? "\u23f1" : "\uD83D\uDCCA") +
        " #" +
        blE.sampleIndex +
        "</span>";
    }
    tooltip.innerHTML =
      '<span class="bt-offset">offset ' +
      offset +
      "</span> &nbsp;" +
      '<span class="bt-hex">0x' +
      formatHexByte(val) +
      "</span>" +
      '<span style="color:#94a3b8"> = ' +
      val +
      "</span>" +
      '<span class="bt-region ' +
      region.cls +
      '">' +
      region.name +
      "</span>" +
      sampleInfo;
    tooltip.classList.add("visible");
  });

  // Throttle mousemove for tooltip positioning
  var moveRAF = 0;
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

  // Click handler: sample-aware for mapped bytes, region fallback otherwise
  grid.addEventListener("click", (e) => {
    var cell = e.target;
    if (!cell.classList?.contains("hex-cell")) {
      highlightHexSample(null);
      return;
    }
    var offset = cell.dataset.offset | 0;

    // Try sample-level highlight first
    if (byteLookup?.[offset]) {
      highlightHexSample(byteLookup[offset]);
      return;
    }

    // Fallback: region highlight
    highlightHexSample(null);
    var rIdx = byteRegion[offset];
    showRegionDetail(regions[rIdx]);
  });

  // Escape to clear hex highlights (tracked for cleanup on re-render)
  renderByteExplorer._escHandler = (e) => {
    if (e.key === "Escape") highlightHexSample(null);
  };
  document.addEventListener("keydown", renderByteExplorer._escHandler);

  return highlightHexSample;
}

function _setupViewModeButtons(
  explorer,
  bytes,
  byteRegion,
  regions,
  sampleCount,
  codec,
  bitMap,
  _byteLookup,
  _totalRows,
  hexContent,
  highlightHexSample
) {
  var hexDecodePanel = explorer.querySelector(".hex-decode-panel");
  var buttons = explorer.querySelectorAll(".byte-explorer-controls button");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      var mode = btn.dataset.view;

      if (mode === "bits") {
        hexDecodePanel.style.display = "none";
        renderBitView(explorer, bytes, byteRegion, regions, sampleCount, codec, bitMap);
      } else {
        var bitView = explorer.querySelector(".bit-view");
        if (bitView) bitView.remove();
        var dp = explorer.querySelector(".bit-decode-panel");
        if (dp) dp.remove();
        highlightHexSample(null);
        hexContent.scrollContainer.style.display = "";
        hexContent.rerender(mode);
      }
    });
  });
}

// ── Main Byte Explorer ───────────────────────────────────────────────

export function renderByteExplorer(primaryBlob, tsBlob, sharedCount, sampleCount, codec) {
  var explorer = $("#byteExplorer");
  if (!explorer) return;

  // Clean up previous keydown listener to prevent leaks
  if (renderByteExplorer._escHandler) {
    document.removeEventListener("keydown", renderByteExplorer._escHandler);
    renderByteExplorer._escHandler = null;
  }

  var regions = [];
  var bytes;
  var insightHtml = "";
  var bitMap = null;

  if (codec === "alp-values" || codec === "alp") {
    var valBlobLen = primaryBlob.byteLength;
    // For alp-values, we only render the value blob (no timestamp concatenation)
    var includeTs = codec === "alp" && tsBlob;
    var tsLen = includeTs && tsBlob ? tsBlob.byteLength : 0;
    var amortizedTsLen = includeTs
      ? sharedCount > 0
        ? Math.round(tsLen / sharedCount)
        : tsLen
      : 0;

    var ALP_HDR = Math.min(ALP_HEADER_SIZE, valBlobLen);
    var alpHdr = parseALPHeader(primaryBlob);
    var alpCount = alpHdr.count,
      alpExp = alpHdr.exponent,
      alpBW = alpHdr.bitWidth;
    var alpMin = alpHdr.minInt,
      alpExc = alpHdr.excCount;

    var bpBytes = Math.ceil((alpCount * alpBW) / 8);
    var excPosBytes = alpExc * 2;
    var excValBytes = alpExc * 8;

    var tsCount = 0,
      firstTs = 0n;
    if (includeTs && tsBlob && tsBlob.byteLength >= TS_HEADER_SIZE) {
      tsCount = (tsBlob[0] << 8) | tsBlob[1];
      firstTs = readI64BE(tsBlob, 2);
    }

    var totalDisplay = valBlobLen + amortizedTsLen;
    bytes = new Uint8Array(totalDisplay);
    bytes.set(primaryBlob, 0);
    if (includeTs && tsBlob && amortizedTsLen > 0) {
      bytes.set(tsBlob.slice(0, amortizedTsLen), valBlobLen);
    }

    var factor10 = `10${superNum(alpExp)}`;
    regions.push({
      name: "ALP Header (14 B)",
      cls: "header",
      start: 0,
      end: ALP_HDR,
      decode: () =>
        "bytes 0\u20111: sample count = " +
        alpCount +
        "\nbyte 2: exponent = " +
        alpExp +
        "  (\u00d7" +
        factor10 +
        " to convert float\u2192int)" +
        "\nbyte 3: bit width = " +
        alpBW +
        "  (bits per FoR offset)" +
        "\nbytes 4\u201311: min int = " +
        alpMin.toString() +
        "  (frame-of-reference base)" +
        "\nbytes 12\u201313: exceptions = " +
        alpExc,
    });

    if (bpBytes > 0) {
      var bpEnd = Math.min(ALP_HDR + bpBytes, valBlobLen);
      regions.push({
        name: "Bit-Packed Offsets",
        cls: "values",
        start: ALP_HDR,
        end: bpEnd,
        decode: () =>
          alpCount +
          " offsets \u00d7 " +
          alpBW +
          " bits = " +
          bpBytes +
          " bytes" +
          "\nEach offset = (scaled_integer \u2212 " +
          alpMin.toString() +
          ")" +
          "\nReconstruct: (offset + min) \u00f7 " +
          factor10 +
          " \u2192 original float64",
      });
    }

    if (alpExc > 0) {
      var epStart = ALP_HDR + bpBytes;
      var epEnd = Math.min(epStart + excPosBytes, valBlobLen);
      var evEnd = Math.min(epEnd + excValBytes, valBlobLen);
      regions.push({
        name: "Exception Positions",
        cls: "exceptions",
        start: epStart,
        end: epEnd,
        decode: () =>
          alpExc +
          " \u00d7 u16 BE indices of non-roundtrippable values" +
          "\nThese values couldn\u2019t survive \u00d7" +
          factor10 +
          " \u2192 int \u2192 \u00f7" +
          factor10,
      });
      regions.push({
        name: "Exception Raw Values",
        cls: "exceptions",
        start: epEnd,
        end: evEnd,
        decode: () =>
          alpExc +
          " \u00d7 f64 BE (raw IEEE-754, 8 bytes each)" +
          "\nStored verbatim for lossless reconstruction",
      });
    }

    if (includeTs && amortizedTsLen > 0) {
      var tsHdrEnd = Math.min(TS_HEADER_SIZE, amortizedTsLen);
      regions.push({
        name: "Timestamp Header",
        cls: "timestamps",
        start: valBlobLen,
        end: valBlobLen + tsHdrEnd,
        decode: () =>
          "bytes 0\u20111: count = " +
          tsCount +
          "\nbytes 2\u20119: first timestamp" +
          "\n  " +
          formatEpochNs(firstTs) +
          "\n  epoch ns: " +
          firstTs.toString(),
      });
      if (amortizedTsLen > TS_HEADER_SIZE) {
        regions.push({
          name: "Timestamp \u0394\u0394 Body",
          cls: "timestamps",
          start: valBlobLen + TS_HEADER_SIZE,
          end: valBlobLen + amortizedTsLen,
          decode: () => {
            var body = amortizedTsLen - TS_HEADER_SIZE;
            return (
              body +
              " bytes of delta-of-delta encoded timestamps" +
              "\nGorilla: 0=same\u0394 | 10+7b | 110+9b | 1110+12b | 1111+64b" +
              "\nFull blob: " +
              formatBytes(tsLen) +
              " shared \u00f7 " +
              sharedCount +
              " = " +
              formatBytes(amortizedTsLen) +
              "/series"
            );
          },
        });
      }
    }

    insightHtml = buildALPInsightHtml({
      count: alpCount,
      exponent: alpExp,
      bitWidth: alpBW,
      minInt: alpMin,
      excCount: alpExc,
      bitpackedBytes: bpBytes,
      valBlobLen: valBlobLen,
      tsLen: includeTs ? tsLen : 0,
      amortizedTsLen: amortizedTsLen,
      sharedCount: includeTs ? sharedCount : 0,
      tsCount: tsCount,
      firstTs: firstTs,
    });

    // Build ALP bit map for interactive bit view (values only for alp-values)
    bitMap = buildALPBitMap(primaryBlob, includeTs ? tsBlob : null, sampleCount);
  } else {
    bytes = primaryBlob;
    var totalBytes = bytes.byteLength;
    var hdrLen = Math.min(18, totalBytes);
    var xorHdr = parseXORHeader(bytes);
    var xorCount = xorHdr.count,
      xorFirstTs = xorHdr.firstTs,
      xorFirstVal = xorHdr.firstVal;
    var streamBytes = totalBytes - hdrLen;

    regions.push({
      name: "Header (18 B)",
      cls: "header",
      start: 0,
      end: hdrLen,
      decode: () =>
        "bytes 0\u20111: sample count = " +
        xorCount +
        "\nbytes 2\u20119: first timestamp (i64 BE)" +
        "\n  " +
        formatEpochNs(xorFirstTs) +
        "\nbytes 10\u201317: first value (f64 BE)" +
        "\n  " +
        xorFirstVal.toPrecision(8),
    });
    regions.push({
      name: "Interleaved \u0394\u0394ts + XOR values",
      cls: "timestamps",
      start: hdrLen,
      end: totalBytes,
      decode: () => {
        var bps = xorCount > 1 ? ((streamBytes * 8) / (xorCount - 1)).toFixed(1) : "-";
        return (
          streamBytes +
          " bytes (" +
          streamBytes * 8 +
          " bits) for " +
          (xorCount - 1) +
          " samples" +
          "\n\nPer sample, interleaved:" +
          "\n  \u23f1 Timestamp \u0394\u0394: 0=same | 10+7b | 110+9b | 1110+12b | 1111+64b" +
          "\n  \u2295 Value XOR: 0=same | 10=reuse window | 11+6b+6b=new window" +
          "\n\n~" +
          bps +
          " bits/sample total"
        );
      },
    });

    insightHtml = buildXORInsightHtml({
      count: xorCount,
      firstTs: xorFirstTs,
      firstVal: xorFirstVal,
      totalBytes: totalBytes,
    });

    // Build XOR bit map using annotated decoder
    try {
      var annotated = decodeChunkAnnotated(primaryBlob);
      bitMap = annotated.bitMap;
    } catch (e) {
      console.warn("Annotated decode failed:", e);
    }
  }

  // Region lookup per byte
  var byteRegion = buildByteRegionMap(regions, bytes.length);

  // Build byte-to-sample lookup for hex/decimal interactive views
  var byteLookup = buildByteLookup(bitMap, bytes.length);

  var totalRows = Math.ceil(bytes.length / HEX_COLS);

  function showRegionDetail(region) {
    var detail = explorer.querySelector("#regionDetail");
    detail.innerHTML =
      '<div class="region-detail-card">' +
      '<h5><span class="region-badge ' +
      region.cls +
      '">' +
      region.name +
      "</span> " +
      formatBytes(region.end - region.start) +
      " \u00b7 bytes " +
      region.start +
      "\u2013" +
      (region.end - 1) +
      "</h5>" +
      '<div class="region-detail-grid">' +
      '<div class="rd-item"><div class="rd-label">Offset</div><div class="rd-value">' +
      region.start +
      "</div></div>" +
      '<div class="rd-item"><div class="rd-label">Length</div><div class="rd-value">' +
      (region.end - region.start) +
      "</div></div>" +
      '<div class="rd-item"><div class="rd-label">% of total</div><div class="rd-value">' +
      (((region.end - region.start) / bytes.length) * 100).toFixed(1) +
      "%</div></div>" +
      "</div>" +
      "<div style=\"margin-top:8px;font-size:11px;color:#6b8a9e;white-space:pre-line;line-height:1.5;font-family:'IBM Plex Mono',monospace\">" +
      region.decode() +
      "</div>" +
      "</div>";
  }

  _buildExplorerShell(explorer, bytes, "");
  // Place codec insight in outer container (above byte layout) if available, else inside explorer
  var insightTarget =
    document.getElementById("codecInsightOuter") || explorer.querySelector("#codecInsight");
  if (insightTarget) insightTarget.innerHTML = insightHtml;
  var viewport = _buildMinimap(explorer, bytes, regions, showRegionDetail);
  var hexContent = _renderHexContent(
    explorer.querySelector(".hex-grid"),
    explorer.querySelector(".hex-grid-scroll"),
    bytes,
    byteRegion,
    regions,
    byteLookup,
    totalRows,
    viewport
  );
  var highlightHexSample = _setupHexInteraction(
    explorer,
    bytes,
    byteRegion,
    regions,
    byteLookup,
    hexContent,
    showRegionDetail
  );
  _setupViewModeButtons(
    explorer,
    bytes,
    byteRegion,
    regions,
    sampleCount,
    codec,
    bitMap,
    byteLookup,
    totalRows,
    hexContent,
    highlightHexSample
  );
}

// ── Separate Timestamp Byte Explorer (for ALP column store) ──────────

export function renderByteExplorerTs(tsBlob, sampleCount) {
  var explorer = document.getElementById("byteExplorerTs");
  if (!explorer || !tsBlob || tsBlob.byteLength === 0) return;

  var bytes = new Uint8Array(tsBlob);
  var totalBytes = bytes.byteLength;
  var regions = [];
  var bitMap = null;

  var tsCount = 0,
    firstTs = 0n;
  if (totalBytes >= TS_HEADER_SIZE) {
    tsCount = (tsBlob[0] << 8) | tsBlob[1];
    firstTs = readI64BE(tsBlob, 2);
  }

  var hdrEnd = Math.min(TS_HEADER_SIZE, totalBytes);
  regions.push({
    name: "Timestamp Header (10 B)",
    cls: "timestamps",
    start: 0,
    end: hdrEnd,
    decode: () =>
      "bytes 0\u20111: count = " +
      tsCount +
      "\nbytes 2\u20119: first timestamp" +
      "\n  " +
      formatEpochNs(firstTs) +
      "\n  epoch ns: " +
      firstTs.toString(),
  });
  if (totalBytes > TS_HEADER_SIZE) {
    regions.push({
      name: "Timestamp \u0394\u0394 Body",
      cls: "timestamps",
      start: TS_HEADER_SIZE,
      end: totalBytes,
      decode: () => {
        var body = totalBytes - TS_HEADER_SIZE;
        return (
          body +
          " bytes of delta-of-delta encoded timestamps" +
          "\nGorilla: 0=same\u0394 | 10+7b | 110+9b | 1110+12b | 1111+64b"
        );
      },
    });
  }

  // Build timestamp bit map
  try {
    var tsR = new BitReader(tsBlob);
    var tsBitMap = [];
    tsR.readBitsNum(16);
    var firstTsVal = BigInt.asIntN(64, tsR.readBits(64));
    tsBitMap.push({
      sampleIndex: 0,
      type: "timestamp",
      startBit: 0,
      endBit: 80,
      encoding: "raw",
      decoded: firstTsVal,
    });
    var prevTs = firstTsVal,
      prevDelta = 0n;
    for (var i = 1; i < tsCount && i < sampleCount; i++) {
      var tsStart = tsR.totalBits;
      var dod, enc;
      if (tsR.readBit() === 0) {
        dod = 0n;
        enc = "dod-zero";
        // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
      } else if (tsR.readBit() === 0) {
        var zz = tsR.readBitsNum(7);
        dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
        enc = "dod-7bit";
        // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
      } else if (tsR.readBit() === 0) {
        var zz2 = tsR.readBitsNum(9);
        dod = BigInt.asIntN(64, BigInt((zz2 >>> 1) ^ -(zz2 & 1)));
        enc = "dod-9bit";
        // biome-ignore lint/suspicious/noDuplicateElseIf: intentional bit-width dispatch
      } else if (tsR.readBit() === 0) {
        var zz3 = tsR.readBitsNum(12);
        dod = BigInt.asIntN(64, BigInt((zz3 >>> 1) ^ -(zz3 & 1)));
        enc = "dod-12bit";
      } else {
        dod = BigInt.asIntN(64, tsR.readBits(64));
        enc = "dod-64bit";
      }
      var delta = prevDelta + dod;
      var ts = prevTs + delta;
      prevDelta = delta;
      prevTs = ts;
      tsBitMap.push({
        sampleIndex: i,
        type: "timestamp",
        startBit: tsStart,
        endBit: tsR.totalBits,
        encoding: enc,
        decoded: ts,
        dod: dod,
        delta: delta,
      });
    }
    bitMap = tsBitMap;
  } catch (e) {
    console.warn("Timestamp bit map failed:", e);
  }

  var byteRegion = buildByteRegionMap(regions, totalBytes);
  var byteLookup = buildByteLookup(bitMap, totalBytes);
  var totalRows = Math.ceil(totalBytes / HEX_COLS);

  function showRegionDetail(region) {
    var detail = explorer.querySelector("#regionDetailTs");
    if (!detail) return;
    detail.innerHTML =
      '<div class="region-detail-card">' +
      '<h5><span class="region-badge ' +
      region.cls +
      '">' +
      region.name +
      "</span> " +
      formatBytes(region.end - region.start) +
      " \u00b7 bytes " +
      region.start +
      "\u2013" +
      (region.end - 1) +
      "</h5>" +
      "<div style=\"margin-top:8px;font-size:11px;color:#6b8a9e;white-space:pre-line;line-height:1.5;font-family:'IBM Plex Mono',monospace\">" +
      region.decode() +
      "</div>" +
      "</div>";
  }

  // Build shell
  var viewId = `hexViewTs-${Date.now()}`;
  explorer.innerHTML =
    '<div class="byte-explorer-header">' +
    '<h4>\uD83D\uDD2C Timestamp Explorer <span style="font-weight:400;color:#6b8a9e;font-size:11px">' +
    formatBytes(totalBytes) +
    " \u00b7 " +
    totalBytes.toLocaleString() +
    " bytes</span></h4>" +
    '<div class="byte-explorer-controls">' +
    '<button class="active" data-view="hex">Hex</button>' +
    '<button data-view="decimal">Dec</button>' +
    '<button data-view="bits">Bits</button>' +
    "</div>" +
    "</div>" +
    '<div class="byte-minimap" id="byteMinimapTs"></div>' +
    '<div class="hex-grid-scroll" id="' +
    viewId +
    '">' +
    '<div class="hex-grid" id="hexGridTs" style="grid-template-columns: 56px repeat(' +
    HEX_COLS +
    ', minmax(0, 1fr)) minmax(0, 220px);"></div>' +
    "</div>" +
    '<div class="hex-decode-panel" id="hexDecodePanelTs" style="display:none"></div>' +
    '<div id="regionDetailTs"></div>';

  // Build minimap
  var minimap = explorer.querySelector(".byte-minimap");
  regions.forEach((r) => {
    var seg = document.createElement("div");
    seg.className = "mm-seg";
    seg.style.width = `${Math.max(1, ((r.end - r.start) / totalBytes) * 100)}%`;
    seg.style.background = "#06b6d4";
    seg.title = `${r.name}: ${formatBytes(r.end - r.start)}`;
    seg.addEventListener("click", () => {
      showRegionDetail(r);
    });
    minimap.appendChild(seg);
  });
  var viewport = document.createElement("div");
  viewport.className = "mm-viewport";
  minimap.appendChild(viewport);

  var hexContent = _renderHexContent(
    explorer.querySelector(".hex-grid"),
    explorer.querySelector(".hex-grid-scroll"),
    bytes,
    byteRegion,
    regions,
    byteLookup,
    totalRows,
    viewport
  );
  var highlightHexSample = _setupHexInteraction(
    explorer,
    bytes,
    byteRegion,
    regions,
    byteLookup,
    hexContent,
    showRegionDetail
  );
  _setupViewModeButtons(
    explorer,
    bytes,
    byteRegion,
    regions,
    sampleCount,
    "xor",
    bitMap,
    byteLookup,
    totalRows,
    hexContent,
    highlightHexSample
  );
}
