// ── Interactive Byte Explorer ──────────────────────────────────────

import { $, formatBytes, readI64BE, readF64BE, formatEpochNs, superNum, formatHexByte } from './utils.js';
import { decodeChunkAnnotated, BitReader } from './codec.js';
import {
  buildALPInsightHtml, buildXORInsightHtml,
  parseALPHeader, parseXORHeader,
  buildALPBitMap, buildByteLookup, entryByteRange,
  buildByteRegionMap, renderHexRowHTML, encodingDescription,
} from './byte-explorer-logic.js';

const HEX_COLS = 32;
const MAX_BITS = 2048;
const BITS_PER_ROW = 64;
const MAX_INITIAL_ROWS = 100;
const SCROLL_THRESHOLD = 200;

// ── Interactive Bit View ─────────────────────────────────────────────

function renderBitView(explorer, bytes, byteRegion, regions, sampleCount, codec, bitMap) {
  const scrollContainer = explorer.querySelector('.hex-grid-scroll');
  scrollContainer.style.display = 'none';

  const existing = explorer.querySelector('.bit-view');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.className = 'bit-view';

  const maxBits = Math.min(bytes.length * 8, MAX_BITS);
  const truncated = bytes.length * 8 > maxBits;

  // Build bit-to-sample lookup for click interaction
  const bitLookup = {}; // bitIndex -> bitMap entry
  if (bitMap) {
    for (let mi = 0; mi < bitMap.length; mi++) {
      const entry = bitMap[mi];
      // For ALP values, bits are in the value blob (offset 0 in combined buffer)
      // For timestamps, bits start at blobOffset
      const baseOffset = (entry.blobOffset || 0) * 8;
      for (let b = entry.startBit; b < entry.endBit; b++) {
        bitLookup[baseOffset + b] = entry;
      }
    }
  }

  // Decode panel
  const decodePanel = document.createElement('div');
  decodePanel.className = 'bit-decode-panel';
  decodePanel.style.display = 'none';

  let activeEntry = null;

  function highlightBitRange(entry, container) {
    // Clear previous highlights
    container.querySelectorAll('.bit.bit-highlight').forEach(function(el) {
      el.classList.remove('bit-highlight', 'bit-highlight-ts', 'bit-highlight-val');
    });

    if (!entry) {
      decodePanel.style.display = 'none';
      activeEntry = null;
      return;
    }

    activeEntry = entry;
    const baseOffset = (entry.blobOffset || 0) * 8;
    for (let b = entry.startBit; b < entry.endBit; b++) {
      const globalBit = baseOffset + b;
      const el = container.querySelector('.bit[data-bit="' + globalBit + '"]');
      if (el) {
        el.classList.add('bit-highlight');
        el.classList.add(entry.type === 'timestamp' ? 'bit-highlight-ts' : 'bit-highlight-val');
      }
    }

    // Show decode panel
    decodePanel.style.display = '';
    const bits = entry.endBit - entry.startBit;
    let decodedStr;
    if (entry.type === 'timestamp') {
      decodedStr = formatEpochNs(entry.decoded);
    } else {
      decodedStr = typeof entry.decoded === 'number' ? entry.decoded.toPrecision(8) : String(entry.decoded);
    }

    let encodingDesc = '';
    if (entry.encoding === 'raw') {
      encodingDesc = 'Raw (uncompressed first sample)';
    } else if (entry.encoding === 'dod-zero') {
      encodingDesc = 'Δ² = 0 → prefix <code>0</code> (1 bit)';
    } else if (entry.encoding === 'dod-7bit') {
      encodingDesc = 'Δ² ≤ ±64 → prefix <code>10</code> + 7-bit zigzag';
    } else if (entry.encoding === 'dod-9bit') {
      encodingDesc = 'Δ² ≤ ±256 → prefix <code>110</code> + 9-bit zigzag';
    } else if (entry.encoding === 'dod-12bit') {
      encodingDesc = 'Δ² ≤ ±2048 → prefix <code>1110</code> + 12-bit zigzag';
    } else if (entry.encoding === 'dod-64bit') {
      encodingDesc = 'Large Δ² → prefix <code>1111</code> + 64-bit raw';
    } else if (entry.encoding === 'xor-zero') {
      encodingDesc = 'XOR = 0 → prefix <code>0</code> (identical value)';
    } else if (entry.encoding === 'xor-reuse') {
      encodingDesc = 'XOR reuse window → prefix <code>10</code> + ' + entry.meaningful + ' meaningful bits';
    } else if (entry.encoding === 'xor-new') {
      encodingDesc = 'XOR new window → prefix <code>11</code> + 6b leading(' + entry.leading + ') + 6b length(' + entry.meaningful + ') + ' + entry.meaningful + ' bits';
    } else if (entry.encoding === 'alp-bitpacked') {
      encodingDesc = 'ALP bit-packed offset = ' + entry.offset + ' (' + entry.bitWidth + ' bits)';
    } else if (entry.encoding === 'alp-exception') {
      encodingDesc = '⚠️ ALP exception — stored as raw f64';
    }

    const typeIcon = entry.type === 'timestamp' ? '⏱' : '📊';
    const typeLabel = entry.type === 'timestamp' ? 'Timestamp' : 'Value';

    decodePanel.innerHTML =
      '<div class="bdp-header">' +
        '<span class="bdp-type ' + entry.type + '">' + typeIcon + ' ' + typeLabel + '</span>' +
        '<span class="bdp-sample">Sample #' + entry.sampleIndex + '</span>' +
        '<span class="bdp-bits">' + bits + ' bits (bit ' + entry.startBit + '–' + (entry.endBit - 1) + ')</span>' +
      '</div>' +
      '<div class="bdp-value">' + decodedStr + '</div>' +
      '<div class="bdp-encoding">' + encodingDesc + '</div>' +
      (entry.dod !== undefined ? '<div class="bdp-detail">Δ² = ' + entry.dod.toString() + ', Δ = ' + entry.delta.toString() + '</div>' : '') +
      (entry.xor !== undefined && entry.xor !== 0n ? '<div class="bdp-detail">XOR = 0x' + entry.xor.toString(16).padStart(16, '0') + '</div>' : '');
  }

  regions.forEach(function(region) {
    const regionHeader = document.createElement('div');
    regionHeader.style.cssText = 'margin:6px 0 4px;font-weight:700;font-size:11px;color:#f59e0b;';
    regionHeader.textContent = '\u2500\u2500 ' + region.name + ' (bytes ' + region.start + '\u2013' + (region.end - 1) + ') \u2500\u2500';
    container.appendChild(regionHeader);

    const regionBytes = bytes.slice(region.start, Math.min(region.end, Math.ceil(maxBits / 8)));
    const bitsPerRow = BITS_PER_ROW;
    let prevEntry = null;

    for (let rowStart = 0; rowStart < regionBytes.length * 8; rowStart += bitsPerRow) {
      const rowEl = document.createElement('div');
      rowEl.className = 'bit-row';

      const label = document.createElement('span');
      label.className = 'bit-sample-label';
      label.textContent = 'b' + (region.start * 8 + rowStart);
      rowEl.appendChild(label);

      const rowEnd = Math.min(rowStart + bitsPerRow, regionBytes.length * 8);
      for (let b = rowStart; b < rowEnd; b++) {
        const byteOff = Math.floor(b / 8);
        const bitOff = 7 - (b % 8);
        const bitVal = (regionBytes[byteOff] >> bitOff) & 1;

        const globalBitIdx = region.start * 8 + b;
        const bitEl = document.createElement('span');
        bitEl.className = 'bit ' + (bitVal ? 'b1' : 'b0');
        bitEl.textContent = bitVal;
        bitEl.dataset.bit = globalBitIdx;

        // Check if this bit belongs to a mapped sample
        const mapEntry = bitLookup[globalBitIdx];
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
          bitEl.title = (mapEntry.type === 'timestamp' ? '⏱ ' : '📊 ') + 'Sample #' + mapEntry.sampleIndex;
          prevEntry = mapEntry;
        }

        rowEl.appendChild(bitEl);

        if ((b + 1) % 8 === 0 && b + 1 < rowEnd) {
          const sep = document.createElement('span');
          sep.style.cssText = 'width:4px;';
          rowEl.appendChild(sep);
        }
      }

      container.appendChild(rowEl);
    }

    if (region.end * 8 > maxBits) return;
  });

  if (truncated) {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:8px;color:#94a3b8;font-size:10px;';
    note.textContent = 'Showing first ' + maxBits + ' of ' + (bytes.length * 8) + ' bits...';
    container.appendChild(note);
  }

  // Click handler for bits
  container.addEventListener('click', function(e) {
    const bitEl = e.target.closest('.bit-mapped');
    if (!bitEl) {
      highlightBitRange(null, container);
      return;
    }
    const globalBit = parseInt(bitEl.dataset.bit);
    const entry = bitLookup[globalBit];
    if (entry) {
      highlightBitRange(entry, container);
    }
  });

  // Hover handler
  container.addEventListener('mouseover', function(e) {
    const bitEl = e.target.closest('.bit-mapped');
    if (bitEl) {
      bitEl.classList.add('bit-hover');
    }
  });
  container.addEventListener('mouseout', function(e) {
    const bitEl = e.target.closest('.bit-mapped');
    if (bitEl) {
      bitEl.classList.remove('bit-hover');
    }
  });

  // Escape to clear
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      highlightBitRange(null, container);
    }
  }
  document.addEventListener('keydown', onKeyDown);

  explorer.querySelector('#regionDetail').before(decodePanel);
  explorer.querySelector('#regionDetail').before(container);
}

// ── Main Byte Explorer ───────────────────────────────────────────────

export function renderByteExplorer(primaryBlob, tsBlob, sharedCount, sampleCount, codec) {
  const explorer = $('#byteExplorer');
  if (!explorer) return;

  // Clean up previous keydown listener to prevent leaks
  if (renderByteExplorer._escHandler) {
    document.removeEventListener('keydown', renderByteExplorer._escHandler);
    renderByteExplorer._escHandler = null;
  }

  const regions = [];
  let bytes;
  let insightHtml = '';
  let bitMap = null;

  if (codec === 'alp') {
    const valBlobLen = primaryBlob.byteLength;
    const tsLen = tsBlob ? tsBlob.byteLength : 0;
    const amortizedTsLen = sharedCount > 0 ? Math.round(tsLen / sharedCount) : tsLen;

    const ALP_HDR = Math.min(14, valBlobLen);
    const alpHdr = parseALPHeader(primaryBlob);
    const alpCount = alpHdr.count, alpExp = alpHdr.exponent, alpBW = alpHdr.bitWidth;
    const alpMin = alpHdr.minInt, alpExc = alpHdr.excCount;

    const bpBytes = Math.ceil(alpCount * alpBW / 8);
    const excPosBytes = alpExc * 2;
    const excValBytes = alpExc * 8;

    let tsCount = 0, firstTs = 0n;
    if (tsBlob && tsBlob.byteLength >= 10) {
      tsCount = (tsBlob[0] << 8) | tsBlob[1];
      firstTs = readI64BE(tsBlob, 2);
    }

    const totalDisplay = valBlobLen + amortizedTsLen;
    bytes = new Uint8Array(totalDisplay);
    bytes.set(primaryBlob, 0);
    if (tsBlob && amortizedTsLen > 0) {
      bytes.set(tsBlob.slice(0, amortizedTsLen), valBlobLen);
    }

    const factor10 = '10' + superNum(alpExp);
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
      const bpEnd = Math.min(ALP_HDR + bpBytes, valBlobLen);
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
      const epStart = ALP_HDR + bpBytes;
      const epEnd = Math.min(epStart + excPosBytes, valBlobLen);
      const evEnd = Math.min(epEnd + excValBytes, valBlobLen);
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
      const tsHdrEnd = Math.min(10, amortizedTsLen);
      regions.push({
        name: 'Timestamp Header', cls: 'timestamps', start: valBlobLen, end: valBlobLen + tsHdrEnd,
        decode: function() {
          return 'bytes 0\u20111: count = ' + tsCount +
                 '\nbytes 2\u20119: first timestamp' +
                 '\n  ' + formatEpochNs(firstTs) +
                 '\n  epoch ns: ' + firstTs.toString();
        }
      });
      if (amortizedTsLen > 10) {
        regions.push({
          name: 'Timestamp \u0394\u0394 Body', cls: 'timestamps', start: valBlobLen + 10, end: valBlobLen + amortizedTsLen,
          decode: function() {
            const body = amortizedTsLen - 10;
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
    const totalBytes = bytes.byteLength;
    const hdrLen = Math.min(18, totalBytes);
    const xorHdr = parseXORHeader(bytes);
    const xorCount = xorHdr.count, xorFirstTs = xorHdr.firstTs, xorFirstVal = xorHdr.firstVal;
    const streamBytes = totalBytes - hdrLen;

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
        const bps = xorCount > 1 ? (streamBytes * 8 / (xorCount - 1)).toFixed(1) : '-';
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
      const annotated = decodeChunkAnnotated(primaryBlob);
      bitMap = annotated.bitMap;
    } catch (e) {
      console.warn('Annotated decode failed:', e);
    }
  }

  // Region lookup per byte
  const byteRegion = buildByteRegionMap(regions, bytes.length);

  // Build byte-to-sample lookup for hex/decimal interactive views
  const byteLookup = buildByteLookup(bitMap, bytes.length);

  const COLS = HEX_COLS;
  const totalRows = Math.ceil(bytes.length / COLS);
  const viewId = 'hexView-' + Date.now();

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
      '<div class="hex-grid" id="hexGrid" style="grid-template-columns: 56px repeat(' + COLS + ', minmax(0, 1fr)) minmax(60px, auto);"></div>' +
    '</div>' +
    '<div class="hex-decode-panel" id="hexDecodePanel" style="display:none"></div>' +
    '<div id="regionDetail"></div>';

  // Build minimap
  const minimap = explorer.querySelector('#byteMinimap');
  const totalLen = bytes.length;
  regions.forEach(function(r) {
    const seg = document.createElement('div');
    seg.className = 'mm-seg';
    seg.style.width = Math.max(1, ((r.end - r.start) / totalLen) * 100) + '%';
    seg.style.background = r.cls === 'header' ? '#8b5cf6' : r.cls === 'timestamps' ? '#06b6d4' : r.cls === 'exceptions' ? '#f59e0b' : '#10b981';
    seg.title = r.name + ': ' + formatBytes(r.end - r.start);
    seg.addEventListener('click', function() {
      const targetRow = Math.floor(r.start / COLS);
      const gridEl = explorer.querySelector('.hex-grid-scroll');
      const rowEls = gridEl.querySelectorAll('.hex-offset');
      if (rowEls[targetRow]) rowEls[targetRow].scrollIntoView({ behavior: 'smooth', block: 'start' });
      showRegionDetail(r);
    });
    minimap.appendChild(seg);
  });

  // Viewport indicator
  const viewport = document.createElement('div');
  viewport.className = 'mm-viewport';
  minimap.appendChild(viewport);

  // Build hex grid — batch via innerHTML (single DOM write)
  const grid = explorer.querySelector('#hexGrid');
  const scrollContainer = explorer.querySelector('.hex-grid-scroll');
  let initialRows = Math.min(totalRows, MAX_INITIAL_ROWS);

  // cellsByOffset: O(1) lookup for highlight instead of querySelector
  let cellsByOffset = {};

  function renderBatch(startRow, count, mode) {
    const htmlParts = [];
    for (let r = startRow; r < startRow + count; r++) {
      htmlParts.push(renderHexRowHTML(r, COLS, bytes, byteRegion, regions, mode, byteLookup));
    }
    return htmlParts.join('');
  }

  function indexCells() {
    cellsByOffset = {};
    const cells = grid.querySelectorAll('.hex-cell[data-offset]');
    for (let i = 0; i < cells.length; i++) {
      cellsByOffset[cells[i].dataset.offset] = cells[i];
    }
  }

  grid.innerHTML = renderBatch(0, initialRows, 'hex');
  indexCells();

  // Lazy render remaining rows
  let renderedRows = initialRows;
  let currentMode = 'hex';
  let sentinel;
  if (totalRows > initialRows) {
    sentinel = document.createElement('div');
    sentinel.style.height = '1px';
    sentinel.style.gridColumn = '1 / -1';
    grid.appendChild(sentinel);
  }

  // Throttled scroll handler (combines lazy-load + viewport indicator)
  let scrollRAF = 0;
  scrollContainer.addEventListener('scroll', function() {
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(function() {
      scrollRAF = 0;

      // Viewport indicator
      const scrollFraction = scrollContainer.scrollTop / Math.max(1, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      const vf = scrollContainer.clientHeight / Math.max(1, scrollContainer.scrollHeight);
      viewport.style.left = (scrollFraction * (1 - vf) * 100) + '%';
      viewport.style.width = Math.max(3, vf * 100) + '%';

      // Lazy load
      if (renderedRows < totalRows && sentinel && sentinel.parentNode) {
        const sRect = sentinel.getBoundingClientRect();
        const cRect = scrollContainer.getBoundingClientRect();
        if (sRect.top < cRect.bottom + SCROLL_THRESHOLD) {
          const batch = Math.min(50, totalRows - renderedRows);
          grid.removeChild(sentinel);
          grid.insertAdjacentHTML('beforeend', renderBatch(renderedRows, batch, currentMode));
          // Index new cells
          const newCells = grid.querySelectorAll('.hex-cell[data-offset]');
          for (let i = 0; i < newCells.length; i++) {
            const off = newCells[i].dataset.offset;
            if (!cellsByOffset[off]) cellsByOffset[off] = newCells[i];
          }
          renderedRows += batch;
          if (renderedRows < totalRows) grid.appendChild(sentinel);
        }
      }
    });
  });

  const initVF = scrollContainer.clientHeight / Math.max(1, scrollContainer.scrollHeight);
  viewport.style.left = '0%';
  viewport.style.width = Math.max(3, initVF * 100) + '%';

  // View mode switcher
  const buttons = explorer.querySelectorAll('.byte-explorer-controls button');
  buttons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      buttons.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      const mode = btn.dataset.view;

      if (mode === 'bits') {
        hexDecodePanel.style.display = 'none';
        renderBitView(explorer, bytes, byteRegion, regions, sampleCount, codec, bitMap);
      } else {
        const bitView = explorer.querySelector('.bit-view');
        if (bitView) bitView.remove();
        const dp = explorer.querySelector('.bit-decode-panel');
        if (dp) dp.remove();
        highlightHexSample(null);
        scrollContainer.style.display = '';
        currentMode = mode;
        renderedRows = Math.min(totalRows, MAX_INITIAL_ROWS);
        grid.innerHTML = renderBatch(0, renderedRows, mode);
        indexCells();
        if (renderedRows < totalRows) {
          if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.style.height = '1px';
            sentinel.style.gridColumn = '1 / -1';
          }
          grid.appendChild(sentinel);
        }
      }
    });
  });

  // ── Hex/Decimal decode panel + sample highlight ──
  const hexDecodePanel = explorer.querySelector('#hexDecodePanel');
  let activeHexEntry = null;

  function highlightHexSample(entry) {
    // Clear previous — track highlighted cells for O(1) clear
    if (highlightHexSample._prev) {
      highlightHexSample._prev.forEach(function(c) {
        c.classList.remove('hex-highlight', 'hex-highlight-ts', 'hex-highlight-val');
      });
      highlightHexSample._prev = null;
    }
    if (!entry) {
      hexDecodePanel.style.display = 'none';
      activeHexEntry = null;
      return;
    }
    activeHexEntry = entry;

    // Highlight all bytes that belong to this entry — O(1) lookup per byte
    const range = entryByteRange(entry, bytes.length);
    const highlighted = [];
    for (let bi = range.startByte; bi < range.endByte; bi++) {
      const cell = cellsByOffset[bi];
      if (cell) {
        cell.classList.add('hex-highlight');
        cell.classList.add(entry.type === 'timestamp' ? 'hex-highlight-ts' : 'hex-highlight-val');
        highlighted.push(cell);
      }
    }
    highlightHexSample._prev = highlighted;

    // Show decode info
    hexDecodePanel.style.display = '';
    const bits = entry.endBit - entry.startBit;
    const spanBytes = range.endByte - range.startByte;
    let decodedStr;
    if (entry.type === 'timestamp') {
      decodedStr = formatEpochNs(entry.decoded);
    } else {
      decodedStr = typeof entry.decoded === 'number' ? entry.decoded.toPrecision(8) : String(entry.decoded);
    }

    const encodingDesc = encodingDescription(entry);

    const typeIcon = entry.type === 'timestamp' ? '\u23f1' : '\uD83D\uDCCA';
    const typeLabel = entry.type === 'timestamp' ? 'Timestamp' : 'Value';

    hexDecodePanel.innerHTML =
      '<div class="bdp-header">' +
        '<span class="bdp-type ' + entry.type + '">' + typeIcon + ' ' + typeLabel + '</span>' +
        '<span class="bdp-sample">Sample #' + entry.sampleIndex + '</span>' +
        '<span class="bdp-bits">' + bits + ' bits across ' + spanBytes + ' byte' + (spanBytes !== 1 ? 's' : '') + ' (byte ' + range.startByte + '\u2013' + (range.endByte - 1) + ')</span>' +
      '</div>' +
      '<div class="bdp-value">' + decodedStr + '</div>' +
      '<div class="bdp-encoding">' + encodingDesc + '</div>' +
      (entry.dod !== undefined ? '<div class="bdp-detail">\u0394\u00b2 = ' + entry.dod.toString() + ', \u0394 = ' + entry.delta.toString() + '</div>' : '') +
      (entry.xor !== undefined && entry.xor !== 0n ? '<div class="bdp-detail">XOR = 0x' + entry.xor.toString(16).padStart(16, '0') + '</div>' : '');
  }

  // Tooltip — pre-build structure, update via textContent where possible
  let tooltip = document.querySelector('.byte-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'byte-tooltip';
    document.body.appendChild(tooltip);
  }
  let lastTooltipOffset = -1;

  grid.addEventListener('mouseover', function(e) {
    const cell = e.target;
    if (!cell.classList || !cell.classList.contains('hex-cell')) {
      tooltip.classList.remove('visible');
      lastTooltipOffset = -1;
      return;
    }
    const offset = cell.dataset.offset | 0;
    if (offset === lastTooltipOffset) return;
    lastTooltipOffset = offset;
    const val = bytes[offset];
    const rIdx = byteRegion[offset];
    const region = regions[rIdx];
    let sampleInfo = '';
    if (byteLookup && byteLookup[offset]) {
      const blE = byteLookup[offset];
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
  let moveRAF = 0;
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
    const cell = e.target;
    if (!cell.classList || !cell.classList.contains('hex-cell')) { highlightHexSample(null); return; }
    const offset = cell.dataset.offset | 0;

    // Try sample-level highlight first
    if (byteLookup && byteLookup[offset]) {
      highlightHexSample(byteLookup[offset]);
      return;
    }

    // Fallback: region highlight
    highlightHexSample(null);
    const rIdx = byteRegion[offset];
    showRegionDetail(regions[rIdx]);
  });

  // Escape to clear hex highlights (tracked for cleanup on re-render)
  renderByteExplorer._escHandler = function(e) {
    if (e.key === 'Escape') highlightHexSample(null);
  };
  document.addEventListener('keydown', renderByteExplorer._escHandler);

  function showRegionDetail(region) {
    const detail = explorer.querySelector('#regionDetail');
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
}
