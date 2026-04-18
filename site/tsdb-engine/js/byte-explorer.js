// ── Interactive Byte Explorer ──────────────────────────────────────

import { $, formatBytes, readI64BE, readF64BE, formatEpochNs, superNum, formatHexByte } from './utils.js';
import { decodeChunkAnnotated, BitReader } from './codec.js';
import {
  buildALPInsightHtml, buildXORInsightHtml,
  parseALPHeader, parseXORHeader,
  buildALPBitMap, buildByteLookup, entryByteRange,
  buildByteRegionMap, renderHexRowHTML, encodingDescription,
  ALP_HEADER_SIZE, TS_HEADER_SIZE,
} from './byte-explorer-logic.js';

const HEX_COLS = 32;
const MAX_BITS = 2048;
const BITS_PER_ROW = 64;
const MAX_INITIAL_ROWS = 100;
const SCROLL_THRESHOLD = 200;

// ── Shared highlight helpers ─────────────────────────────────────────

function _buildDecodeHTML(entry, spanDesc) {
  var bits = entry.endBit - entry.startBit;
  var decodedStr;
  if (entry.type === 'timestamp') {
    decodedStr = formatEpochNs(entry.decoded);
  } else {
    decodedStr = typeof entry.decoded === 'number' ? entry.decoded.toPrecision(8) : String(entry.decoded);
  }
  var enc = encodingDescription(entry);
  var typeIcon = entry.type === 'timestamp' ? '\u23f1' : '\uD83D\uDCCA';
  var typeLabel = entry.type === 'timestamp' ? 'Timestamp' : 'Value';

  return '<div class="bdp-header">' +
    '<span class="bdp-type ' + entry.type + '">' + typeIcon + ' ' + typeLabel + '</span>' +
    '<span class="bdp-sample">Sample #' + entry.sampleIndex + '</span>' +
    '<span class="bdp-bits">' + spanDesc + '</span>' +
  '</div>' +
  '<div class="bdp-value">' + decodedStr + '</div>' +
  '<div class="bdp-encoding">' + enc + '</div>' +
  (entry.dod !== undefined ? '<div class="bdp-detail">\u0394\u00b2 = ' + entry.dod.toString() + ', \u0394 = ' + entry.delta.toString() + '</div>' : '') +
  (entry.xor !== undefined && entry.xor !== 0n ? '<div class="bdp-detail">XOR = 0x' + entry.xor.toString(16).padStart(16, '0') + '</div>' : '');
}

function _highlightEntry(entry, decodePanel, clearFn, applyFn, setActiveFn) {
  clearFn();
  if (!entry) {
    decodePanel.style.display = 'none';
    setActiveFn(null);
    return;
  }
  setActiveFn(entry);
  var spanDesc = applyFn(entry);
  decodePanel.style.display = '';
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
  regions.forEach(function(region) {
    var regionHeader = document.createElement('div');
    regionHeader.style.cssText = 'margin:6px 0 4px;font-weight:700;font-size:11px;color:#f59e0b;';
    regionHeader.textContent = '\u2500\u2500 ' + region.name + ' (bytes ' + region.start + '\u2013' + (region.end - 1) + ') \u2500\u2500';
    container.appendChild(regionHeader);

    var regionBytes = bytes.slice(region.start, Math.min(region.end, Math.ceil(maxBits / 8)));
    var bitsPerRow = BITS_PER_ROW;
    var prevEntry = null;

    for (var rowStart = 0; rowStart < regionBytes.length * 8; rowStart += bitsPerRow) {
      var rowEl = document.createElement('div');
      rowEl.className = 'bit-row';

      var label = document.createElement('span');
      label.className = 'bit-sample-label';
      label.textContent = 'b' + (region.start * 8 + rowStart);
      rowEl.appendChild(label);

      var rowEnd = Math.min(rowStart + bitsPerRow, regionBytes.length * 8);
      for (var b = rowStart; b < rowEnd; b++) {
        var byteOff = Math.floor(b / 8);
        var bitOff = 7 - (b % 8);
        var bitVal = (regionBytes[byteOff] >> bitOff) & 1;

        var globalBitIdx = region.start * 8 + b;
        var bitEl = document.createElement('span');
        bitEl.className = 'bit ' + (bitVal ? 'b1' : 'b0');
        bitEl.textContent = bitVal;
        bitEl.dataset.bit = globalBitIdx;

        // Check if this bit belongs to a mapped sample
        var mapEntry = bitLookup[globalBitIdx];
        if (mapEntry) {
          bitEl.classList.add('bit-mapped');
          bitEl.classList.add(mapEntry.type === 'timestamp' ? 'bit-ts' : 'bit-val');
          // Alternating sample shade
          bitEl.classList.add(mapEntry.sampleIndex % 2 === 0 ? 'bit-sample-even' : 'bit-sample-odd');
          // Boundary: first bit of a new encoding entry
          if (mapEntry !== prevEntry && prevEntry !== null) {
            bitEl.classList.add('bit-boundary');
          }
          // First mapped bit of the region also gets a boundary
          if (prevEntry === null) {
            bitEl.classList.add('bit-boundary');
          }
          bitEl.title = (mapEntry.type === 'timestamp' ? '\u23f1 ' : '\uD83D\uDCCA ') + 'Sample #' + mapEntry.sampleIndex;
          prevEntry = mapEntry;
        }

        rowEl.appendChild(bitEl);

        if ((b + 1) % 8 === 0 && b + 1 < rowEnd) {
          var sep = document.createElement('span');
          sep.style.cssText = 'width:4px;';
          rowEl.appendChild(sep);
        }
      }

      container.appendChild(rowEl);
    }

    if (region.end * 8 > maxBits) return;
  });

  if (bytes.length * 8 > maxBits) {
    var note = document.createElement('div');
    note.style.cssText = 'margin-top:8px;color:#94a3b8;font-size:10px;';
    note.textContent = 'Showing first ' + maxBits + ' of ' + (bytes.length * 8) + ' bits...';
    container.appendChild(note);
  }
}

function _setupBitInteraction(container, bitLookup, explorer) {
  var decodePanel = document.createElement('div');
  decodePanel.className = 'bit-decode-panel';
  decodePanel.style.display = 'none';

  var activeEntry = null;

  function highlightBitRange(entry) {
    _highlightEntry(
      entry,
      decodePanel,
      function() {
        container.querySelectorAll('.bit.bit-highlight').forEach(function(el) {
          el.classList.remove('bit-highlight', 'bit-highlight-ts', 'bit-highlight-val');
        });
      },
      function(e) {
        var baseOffset = (e.blobOffset || 0) * 8;
        for (var b = e.startBit; b < e.endBit; b++) {
          var globalBit = baseOffset + b;
          var el = container.querySelector('.bit[data-bit="' + globalBit + '"]');
          if (el) {
            el.classList.add('bit-highlight');
            el.classList.add(e.type === 'timestamp' ? 'bit-highlight-ts' : 'bit-highlight-val');
          }
        }
        var bits = e.endBit - e.startBit;
        return bits + ' bits (bit ' + e.startBit + '\u2013' + (e.endBit - 1) + ')';
      },
      function(v) { activeEntry = v; }
    );
  }

  // Click handler for bits
  container.addEventListener('click', function(e) {
    var bitEl = e.target.closest('.bit-mapped');
    if (!bitEl) {
      highlightBitRange(null);
      return;
    }
    var globalBit = parseInt(bitEl.dataset.bit);
    var entry = bitLookup[globalBit];
    if (entry) {
      highlightBitRange(entry);
    }
  });

  // Hover handler
  container.addEventListener('mouseover', function(e) {
    var bitEl = e.target.closest('.bit-mapped');
    if (bitEl) {
      bitEl.classList.add('bit-hover');
    }
  });
  container.addEventListener('mouseout', function(e) {
    var bitEl = e.target.closest('.bit-mapped');
    if (bitEl) {
      bitEl.classList.remove('bit-hover');
    }
  });

  // Escape to clear
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      highlightBitRange(null);
    }
  }
  document.addEventListener('keydown', onKeyDown);

  explorer.querySelector('#regionDetail').before(decodePanel);
  explorer.querySelector('#regionDetail').before(container);
}

// ── Interactive Bit View ─────────────────────────────────────────────

function renderBitView(explorer, bytes, byteRegion, regions, sampleCount, codec, bitMap) {
  var scrollContainer = explorer.querySelector('.hex-grid-scroll');
  scrollContainer.style.display = 'none';

  var existing = explorer.querySelector('.bit-view');
  if (existing) existing.remove();

  var container = document.createElement('div');
  container.className = 'bit-view';

  var maxBits = Math.min(bytes.length * 8, MAX_BITS);
  var bitLookup = _buildBitLookup(bitMap);

  _renderBitGrid(container, bytes, regions, maxBits, bitLookup);
  _setupBitInteraction(container, bitLookup, explorer);
}

// ── Explorer shell helpers ───────────────────────────────────────────

function _buildExplorerShell(explorer, bytes, insightHtml) {
  var viewId = 'hexView-' + Date.now();
  explorer.innerHTML =
    '<div class="byte-explorer-header">' +
      '<h4>\uD83D\uDD2C Byte Explorer <span style="font-weight:400;color:#6b8a9e;font-size:11px">' + formatBytes(bytes.length) + ' \u00b7 ' + bytes.length.toLocaleString() + ' bytes</span></h4>' +
      '<div class="byte-explorer-controls">' +
        '<button class="active" data-view="hex">Hex</button>' +
        '<button data-view="decimal">Dec</button>' +
        '<button data-view="bits">Bits</button>' +
      '</div>' +
    '</div>' +
    '<div id="codecInsight">' + insightHtml + '</div>' +
    '<div class="byte-minimap" id="byteMinimap"></div>' +
    '<div class="hex-grid-scroll" id="' + viewId + '">' +
      '<div class="hex-grid" id="hexGrid" style="grid-template-columns: 56px repeat(' + HEX_COLS + ', minmax(0, 1fr)) minmax(0, 220px);"></div>' +
    '</div>' +
    '<div class="hex-decode-panel" id="hexDecodePanel" style="display:none"></div>' +
    '<div id="regionDetail"></div>';
}

function _buildMinimap(explorer, bytes, regions, showRegionDetail) {
  var minimap = explorer.querySelector('#byteMinimap');
  var totalLen = bytes.length;
  regions.forEach(function(r) {
    var seg = document.createElement('div');
    seg.className = 'mm-seg';
    seg.style.width = Math.max(1, ((r.end - r.start) / totalLen) * 100) + '%';
    seg.style.background = r.cls === 'header' ? '#8b5cf6' : r.cls === 'timestamps' ? '#06b6d4' : r.cls === 'exceptions' ? '#f59e0b' : '#10b981';
    seg.title = r.name + ': ' + formatBytes(r.end - r.start);
    seg.addEventListener('click', function() {
      var targetRow = Math.floor(r.start / HEX_COLS);
      var gridEl = explorer.querySelector('.hex-grid-scroll');
      var rowEls = gridEl.querySelectorAll('.hex-offset');
      if (rowEls[targetRow]) rowEls[targetRow].scrollIntoView({ behavior: 'smooth', block: 'start' });
      showRegionDetail(r);
    });
    minimap.appendChild(seg);
  });

  // Viewport indicator
  var viewport = document.createElement('div');
  viewport.className = 'mm-viewport';
  minimap.appendChild(viewport);
  return viewport;
}

function _renderHexContent(gridEl, scrollContainer, bytes, byteRegion, regions, byteLookup, totalRows, viewport) {
  var state = {
    cellsByOffset: {},
    renderedRows: 0,
    currentMode: 'hex',
    sentinel: null,
  };

  function renderBatch(startRow, count, mode) {
    var htmlParts = [];
    for (var r = startRow; r < startRow + count; r++) {
      htmlParts.push(renderHexRowHTML(r, HEX_COLS, bytes, byteRegion, regions, mode, byteLookup));
    }
    return htmlParts.join('');
  }

  function indexCells() {
    state.cellsByOffset = {};
    var cells = gridEl.querySelectorAll('.hex-cell[data-offset]');
    for (var i = 0; i < cells.length; i++) {
      state.cellsByOffset[cells[i].dataset.offset] = cells[i];
    }
  }

  var initialRows = Math.min(totalRows, MAX_INITIAL_ROWS);
  gridEl.innerHTML = renderBatch(0, initialRows, 'hex');
  indexCells();
  state.renderedRows = initialRows;

  // Lazy render remaining rows
  if (totalRows > initialRows) {
    state.sentinel = document.createElement('div');
    state.sentinel.style.height = '1px';
    state.sentinel.style.gridColumn = '1 / -1';
    gridEl.appendChild(state.sentinel);
  }

  // Throttled scroll handler (combines lazy-load + viewport indicator)
  var scrollRAF = 0;
  scrollContainer.addEventListener('scroll', function() {
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(function() {
      scrollRAF = 0;

      // Viewport indicator
      var scrollFraction = scrollContainer.scrollTop / Math.max(1, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      var vf = scrollContainer.clientHeight / Math.max(1, scrollContainer.scrollHeight);
      viewport.style.left = (scrollFraction * (1 - vf) * 100) + '%';
      viewport.style.width = Math.max(3, vf * 100) + '%';

      // Lazy load
      if (state.renderedRows < totalRows && state.sentinel && state.sentinel.parentNode) {
        var sRect = state.sentinel.getBoundingClientRect();
        var cRect = scrollContainer.getBoundingClientRect();
        if (sRect.top < cRect.bottom + SCROLL_THRESHOLD) {
          var batch = Math.min(50, totalRows - state.renderedRows);
          gridEl.removeChild(state.sentinel);
          gridEl.insertAdjacentHTML('beforeend', renderBatch(state.renderedRows, batch, state.currentMode));
          // Index new cells
          var newCells = gridEl.querySelectorAll('.hex-cell[data-offset]');
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
  viewport.style.left = '0%';
  viewport.style.width = Math.max(3, initVF * 100) + '%';

  function rerender(mode) {
    state.currentMode = mode;
    state.renderedRows = Math.min(totalRows, MAX_INITIAL_ROWS);
    gridEl.innerHTML = renderBatch(0, state.renderedRows, mode);
    indexCells();
    if (state.renderedRows < totalRows) {
      if (!state.sentinel) {
        state.sentinel = document.createElement('div');
        state.sentinel.style.height = '1px';
        state.sentinel.style.gridColumn = '1 / -1';
      }
      gridEl.appendChild(state.sentinel);
    }
  }

  return { state: state, grid: gridEl, scrollContainer: scrollContainer, rerender: rerender };
}

function _setupHexInteraction(explorer, bytes, byteRegion, regions, byteLookup, hexContent, showRegionDetail) {
  var grid = hexContent.grid;
  var hexDecodePanel = explorer.querySelector('#hexDecodePanel');
  var activeHexEntry = null;

  function highlightHexSample(entry) {
    _highlightEntry(
      entry,
      hexDecodePanel,
      function() {
        if (highlightHexSample._prev) {
          highlightHexSample._prev.forEach(function(c) {
            c.classList.remove('hex-highlight', 'hex-highlight-ts', 'hex-highlight-val');
          });
          highlightHexSample._prev = null;
        }
      },
      function(e) {
        var range = entryByteRange(e, bytes.length);
        var highlighted = [];
        for (var bi = range.startByte; bi < range.endByte; bi++) {
          var cell = hexContent.state.cellsByOffset[bi];
          if (cell) {
            cell.classList.add('hex-highlight');
            cell.classList.add(e.type === 'timestamp' ? 'hex-highlight-ts' : 'hex-highlight-val');
            highlighted.push(cell);
          }
        }
        highlightHexSample._prev = highlighted;
        var bits = e.endBit - e.startBit;
        var spanBytes = range.endByte - range.startByte;
        return bits + ' bits across ' + spanBytes + ' byte' + (spanBytes !== 1 ? 's' : '') + ' (byte ' + range.startByte + '\u2013' + (range.endByte - 1) + ')';
      },
      function(v) { activeHexEntry = v; }
    );
  }

  // Tooltip — pre-build structure, update via textContent where possible
  var tooltip = document.querySelector('.byte-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'byte-tooltip';
    document.body.appendChild(tooltip);
  }
  var lastTooltipOffset = -1;

  grid.addEventListener('mouseover', function(e) {
    var cell = e.target;
    if (!cell.classList || !cell.classList.contains('hex-cell')) {
      tooltip.classList.remove('visible');
      lastTooltipOffset = -1;
      return;
    }
    var offset = cell.dataset.offset | 0;
    if (offset === lastTooltipOffset) return;
    lastTooltipOffset = offset;
    var val = bytes[offset];
    var rIdx = byteRegion[offset];
    var region = regions[rIdx];
    var sampleInfo = '';
    if (byteLookup && byteLookup[offset]) {
      var blE = byteLookup[offset];
      sampleInfo = '<span class="bt-sample ' + blE.type + '">' +
        (blE.type === 'timestamp' ? '\u23f1' : '\uD83D\uDCCA') + ' #' + blE.sampleIndex + '</span>';
    }
    tooltip.innerHTML =
      '<span class="bt-offset">offset ' + offset + '</span> &nbsp;' +
      '<span class="bt-hex">0x' + formatHexByte(val) + '</span>' +
      '<span style="color:#94a3b8"> = ' + val + '</span>' +
      '<span class="bt-region ' + region.cls + '">' + region.name + '</span>' +
      sampleInfo;
    tooltip.classList.add('visible');
  });

  // Throttle mousemove for tooltip positioning
  var moveRAF = 0;
  grid.addEventListener('mousemove', function(e) {
    if (moveRAF) return;
    moveRAF = requestAnimationFrame(function() {
      moveRAF = 0;
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top = (e.clientY - 40) + 'px';
    });
  });

  grid.addEventListener('mouseleave', function() {
    tooltip.classList.remove('visible');
    lastTooltipOffset = -1;
  });

  // Click handler: sample-aware for mapped bytes, region fallback otherwise
  grid.addEventListener('click', function(e) {
    var cell = e.target;
    if (!cell.classList || !cell.classList.contains('hex-cell')) { highlightHexSample(null); return; }
    var offset = cell.dataset.offset | 0;

    // Try sample-level highlight first
    if (byteLookup && byteLookup[offset]) {
      highlightHexSample(byteLookup[offset]);
      return;
    }

    // Fallback: region highlight
    highlightHexSample(null);
    var rIdx = byteRegion[offset];
    showRegionDetail(regions[rIdx]);
  });

  // Escape to clear hex highlights (tracked for cleanup on re-render)
  renderByteExplorer._escHandler = function(e) {
    if (e.key === 'Escape') highlightHexSample(null);
  };
  document.addEventListener('keydown', renderByteExplorer._escHandler);

  return highlightHexSample;
}

function _setupViewModeButtons(explorer, bytes, byteRegion, regions, sampleCount, codec, bitMap, byteLookup, totalRows, hexContent, highlightHexSample) {
  var hexDecodePanel = explorer.querySelector('#hexDecodePanel');
  var buttons = explorer.querySelectorAll('.byte-explorer-controls button');

  buttons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      buttons.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var mode = btn.dataset.view;

      if (mode === 'bits') {
        hexDecodePanel.style.display = 'none';
        renderBitView(explorer, bytes, byteRegion, regions, sampleCount, codec, bitMap);
      } else {
        var bitView = explorer.querySelector('.bit-view');
        if (bitView) bitView.remove();
        var dp = explorer.querySelector('.bit-decode-panel');
        if (dp) dp.remove();
        highlightHexSample(null);
        hexContent.scrollContainer.style.display = '';
        hexContent.rerender(mode);
      }
    });
  });
}

// ── Main Byte Explorer ───────────────────────────────────────────────

export function renderByteExplorer(primaryBlob, tsBlob, sharedCount, sampleCount, codec) {
  var explorer = $('#byteExplorer');
  if (!explorer) return;

  // Clean up previous keydown listener to prevent leaks
  if (renderByteExplorer._escHandler) {
    document.removeEventListener('keydown', renderByteExplorer._escHandler);
    renderByteExplorer._escHandler = null;
  }

  var regions = [];
  var bytes;
  var insightHtml = '';
  var bitMap = null;

  if (codec === 'alp') {
    var valBlobLen = primaryBlob.byteLength;
    var tsLen = tsBlob ? tsBlob.byteLength : 0;
    var amortizedTsLen = sharedCount > 0 ? Math.round(tsLen / sharedCount) : tsLen;

    var ALP_HDR = Math.min(ALP_HEADER_SIZE, valBlobLen);
    var alpHdr = parseALPHeader(primaryBlob);
    var alpCount = alpHdr.count, alpExp = alpHdr.exponent, alpBW = alpHdr.bitWidth;
    var alpMin = alpHdr.minInt, alpExc = alpHdr.excCount;

    var bpBytes = Math.ceil(alpCount * alpBW / 8);
    var excPosBytes = alpExc * 2;
    var excValBytes = alpExc * 8;

    var tsCount = 0, firstTs = 0n;
    if (tsBlob && tsBlob.byteLength >= TS_HEADER_SIZE) {
      tsCount = (tsBlob[0] << 8) | tsBlob[1];
      firstTs = readI64BE(tsBlob, 2);
    }

    var totalDisplay = valBlobLen + amortizedTsLen;
    bytes = new Uint8Array(totalDisplay);
    bytes.set(primaryBlob, 0);
    if (tsBlob && amortizedTsLen > 0) {
      bytes.set(tsBlob.slice(0, amortizedTsLen), valBlobLen);
    }

    var factor10 = '10' + superNum(alpExp);
    regions.push({
      name: 'ALP Header (14 B)', cls: 'header', start: 0, end: ALP_HDR,
      decode: function() {
        return 'bytes 0\u20111: sample count = ' + alpCount +
               '\nbyte 2: exponent = ' + alpExp + '  (\u00d7' + factor10 + ' to convert float\u2192int)' +
               '\nbyte 3: bit width = ' + alpBW + '  (bits per FoR offset)' +
               '\nbytes 4\u201311: min int = ' + alpMin.toString() + '  (frame-of-reference base)' +
               '\nbytes 12\u201313: exceptions = ' + alpExc;
      }
    });

    if (bpBytes > 0) {
      var bpEnd = Math.min(ALP_HDR + bpBytes, valBlobLen);
      regions.push({
        name: 'Bit-Packed Offsets', cls: 'values', start: ALP_HDR, end: bpEnd,
        decode: function() {
          return alpCount + ' offsets \u00d7 ' + alpBW + ' bits = ' + bpBytes + ' bytes' +
                 '\nEach offset = (scaled_integer \u2212 ' + alpMin.toString() + ')' +
                 '\nReconstruct: (offset + min) \u00f7 ' + factor10 + ' \u2192 original float64';
        }
      });
    }

    if (alpExc > 0) {
      var epStart = ALP_HDR + bpBytes;
      var epEnd = Math.min(epStart + excPosBytes, valBlobLen);
      var evEnd = Math.min(epEnd + excValBytes, valBlobLen);
      regions.push({
        name: 'Exception Positions', cls: 'exceptions', start: epStart, end: epEnd,
        decode: function() {
          return alpExc + ' \u00d7 u16 BE indices of non-roundtrippable values' +
                 '\nThese values couldn\u2019t survive \u00d7' + factor10 + ' \u2192 int \u2192 \u00f7' + factor10;
        }
      });
      regions.push({
        name: 'Exception Raw Values', cls: 'exceptions', start: epEnd, end: evEnd,
        decode: function() {
          return alpExc + ' \u00d7 f64 BE (raw IEEE-754, 8 bytes each)' +
                 '\nStored verbatim for lossless reconstruction';
        }
      });
    }

    if (amortizedTsLen > 0) {
      var tsHdrEnd = Math.min(TS_HEADER_SIZE, amortizedTsLen);
      regions.push({
        name: 'Timestamp Header', cls: 'timestamps', start: valBlobLen, end: valBlobLen + tsHdrEnd,
        decode: function() {
          return 'bytes 0\u20111: count = ' + tsCount +
                 '\nbytes 2\u20119: first timestamp' +
                 '\n  ' + formatEpochNs(firstTs) +
                 '\n  epoch ns: ' + firstTs.toString();
        }
      });
      if (amortizedTsLen > TS_HEADER_SIZE) {
        regions.push({
          name: 'Timestamp \u0394\u0394 Body', cls: 'timestamps', start: valBlobLen + TS_HEADER_SIZE, end: valBlobLen + amortizedTsLen,
          decode: function() {
            var body = amortizedTsLen - TS_HEADER_SIZE;
            return body + ' bytes of delta-of-delta encoded timestamps' +
                   '\nGorilla: 0=same\u0394 | 10+7b | 110+9b | 1110+12b | 1111+64b' +
                   '\nFull blob: ' + formatBytes(tsLen) + ' shared \u00f7 ' + sharedCount + ' = ' + formatBytes(amortizedTsLen) + '/series';
          }
        });
      }
    }

    insightHtml = buildALPInsightHtml({
      count: alpCount, exponent: alpExp, bitWidth: alpBW, minInt: alpMin,
      excCount: alpExc, bitpackedBytes: bpBytes, valBlobLen: valBlobLen,
      tsLen: tsLen, amortizedTsLen: amortizedTsLen, sharedCount: sharedCount,
      tsCount: tsCount, firstTs: firstTs
    });

    // Build ALP bit map for interactive bit view
    bitMap = buildALPBitMap(primaryBlob, tsBlob, sampleCount);

  } else {
    bytes = primaryBlob;
    var totalBytes = bytes.byteLength;
    var hdrLen = Math.min(18, totalBytes);
    var xorHdr = parseXORHeader(bytes);
    var xorCount = xorHdr.count, xorFirstTs = xorHdr.firstTs, xorFirstVal = xorHdr.firstVal;
    var streamBytes = totalBytes - hdrLen;

    regions.push({
      name: 'Header (18 B)', cls: 'header', start: 0, end: hdrLen,
      decode: function() {
        return 'bytes 0\u20111: sample count = ' + xorCount +
               '\nbytes 2\u20119: first timestamp (i64 BE)' +
               '\n  ' + formatEpochNs(xorFirstTs) +
               '\nbytes 10\u201317: first value (f64 BE)' +
               '\n  ' + xorFirstVal.toPrecision(8);
      }
    });
    regions.push({
      name: 'Interleaved \u0394\u0394ts + XOR values', cls: 'timestamps', start: hdrLen, end: totalBytes,
      decode: function() {
        var bps = xorCount > 1 ? (streamBytes * 8 / (xorCount - 1)).toFixed(1) : '-';
        return streamBytes + ' bytes (' + (streamBytes * 8) + ' bits) for ' + (xorCount - 1) + ' samples' +
               '\n\nPer sample, interleaved:' +
               '\n  \u23f1 Timestamp \u0394\u0394: 0=same | 10+7b | 110+9b | 1110+12b | 1111+64b' +
               '\n  \u2295 Value XOR: 0=same | 10=reuse window | 11+6b+6b=new window' +
               '\n\n~' + bps + ' bits/sample total';
      }
    });

    insightHtml = buildXORInsightHtml({
      count: xorCount, firstTs: xorFirstTs, firstVal: xorFirstVal, totalBytes: totalBytes
    });

    // Build XOR bit map using annotated decoder
    try {
      var annotated = decodeChunkAnnotated(primaryBlob);
      bitMap = annotated.bitMap;
    } catch (e) {
      console.warn('Annotated decode failed:', e);
    }
  }

  // Region lookup per byte
  var byteRegion = buildByteRegionMap(regions, bytes.length);

  // Build byte-to-sample lookup for hex/decimal interactive views
  var byteLookup = buildByteLookup(bitMap, bytes.length);

  var totalRows = Math.ceil(bytes.length / HEX_COLS);

  function showRegionDetail(region) {
    var detail = explorer.querySelector('#regionDetail');
    detail.innerHTML =
      '<div class="region-detail-card">' +
        '<h5><span class="region-badge ' + region.cls + '">' + region.name + '</span> ' + formatBytes(region.end - region.start) + ' \u00b7 bytes ' + region.start + '\u2013' + (region.end - 1) + '</h5>' +
        '<div class="region-detail-grid">' +
          '<div class="rd-item"><div class="rd-label">Offset</div><div class="rd-value">' + region.start + '</div></div>' +
          '<div class="rd-item"><div class="rd-label">Length</div><div class="rd-value">' + (region.end - region.start) + '</div></div>' +
          '<div class="rd-item"><div class="rd-label">% of total</div><div class="rd-value">' + ((region.end - region.start) / bytes.length * 100).toFixed(1) + '%</div></div>' +
        '</div>' +
        '<div style="margin-top:8px;font-size:11px;color:#6b8a9e;white-space:pre-line;line-height:1.5;font-family:\'IBM Plex Mono\',monospace">' + region.decode() + '</div>' +
      '</div>';
  }

  _buildExplorerShell(explorer, bytes, '');
  // Place codec insight in outer container (above byte layout) if available, else inside explorer
  var insightTarget = document.getElementById('codecInsightOuter') || explorer.querySelector('#codecInsight');
  if (insightTarget) insightTarget.innerHTML = insightHtml;
  var viewport = _buildMinimap(explorer, bytes, regions, showRegionDetail);
  var hexContent = _renderHexContent(
    explorer.querySelector('#hexGrid'),
    explorer.querySelector('.hex-grid-scroll'),
    bytes, byteRegion, regions, byteLookup, totalRows, viewport
  );
  var highlightHexSample = _setupHexInteraction(
    explorer, bytes, byteRegion, regions, byteLookup, hexContent, showRegionDetail
  );
  _setupViewModeButtons(
    explorer, bytes, byteRegion, regions, sampleCount, codec, bitMap,
    byteLookup, totalRows, hexContent, highlightHexSample
  );
}
