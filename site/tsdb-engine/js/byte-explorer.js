// ── Interactive Byte Explorer ──────────────────────────────────────

import { $, formatBytes, readI64BE, readF64BE, formatEpochNs, superNum } from './utils.js';
import { decodeChunkAnnotated, BitReader } from './codec.js';

// ── Codec Insight Cards ──────────────────────────────────────────────

function buildALPInsightHtml(p) {
  var factor = '10' + superNum(p.exponent);
  var excPct = p.count > 0 ? ((p.excCount / p.count) * 100).toFixed(1) : '0';
  var rawValBits = p.count * 64;
  var compValBits = p.bitpackedBytes * 8;
  var valRatio = rawValBits > 0 ? (rawValBits / Math.max(1, compValBits)).toFixed(1) : '-';

  var html =
    '<div class="codec-insight">' +
      '<div class="ci-title">\uD83E\uDDEC ALP \u00b7 Adaptive Lossless floating-Point <span class="ci-ref">(CWI Amsterdam, SIGMOD 2024)</span></div>' +
      '<div class="ci-pipeline">' +
        '<div class="ci-step">' +
          '<div class="ci-num">1</div>' +
          '<div class="ci-body">' +
            '<div class="ci-step-title">Decimal Scaling</div>' +
            '<div class="ci-detail">Multiply by ' + factor + ' \u2192 float64 becomes lossless int64</div>' +
            '<div class="ci-example">e.g. 42.150 \u00d7 ' + factor + ' = ' + (42.15 * Math.pow(10, p.exponent)).toFixed(0) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ci-step">' +
          '<div class="ci-num">2</div>' +
          '<div class="ci-body">' +
            '<div class="ci-step-title">Frame of Reference</div>' +
            '<div class="ci-detail">min = ' + p.minInt.toString() + ', offsets need only ' + p.bitWidth + ' bits</div>' +
            '<div class="ci-example">Each value stored as (int \u2212 min) in ' + p.bitWidth + ' bits vs 64 raw</div>' +
          '</div>' +
        '</div>' +
        '<div class="ci-step">' +
          '<div class="ci-num">3</div>' +
          '<div class="ci-body">' +
            '<div class="ci-step-title">Bit-Packing</div>' +
            '<div class="ci-detail">' + p.count + ' \u00d7 ' + p.bitWidth + 'b = ' + formatBytes(p.bitpackedBytes) + '</div>' +
            '<div class="ci-example">' + valRatio + '\u00d7 compression on values alone</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ci-exceptions">' +
        (p.excCount === 0
          ? '\u2705 0 exceptions \u2014 100% of values fit ALP perfectly'
          : '\u26a0\ufe0f ' + p.excCount + ' exceptions (' + excPct + '%) stored as raw f64') +
      '</div>' +
    '</div>';

  if (p.tsCount > 0) {
    html +=
      '<div class="codec-insight ts">' +
        '<div class="ci-title">\uD83D\uDD70\uFE0F Delta-of-Delta Timestamps <span class="ci-ref">(shared across ' + p.sharedCount + ' series)</span></div>' +
        '<div class="ci-pipeline">' +
          '<div class="ci-step">' +
            '<div class="ci-num">\u23F1</div>' +
            '<div class="ci-body">' +
              '<div class="ci-step-title">Base: ' + formatEpochNs(p.firstTs) + '</div>' +
              '<div class="ci-detail">' + formatBytes(p.tsLen) + ' total \u00f7 ' + p.sharedCount + ' series = ' + formatBytes(p.amortizedTsLen) + ' amortized</div>' +
            '</div>' +
          '</div>' +
          '<div class="ci-step">' +
            '<div class="ci-num">\u0394</div>' +
            '<div class="ci-body">' +
              '<div class="ci-step-title">Gorilla-style prefix coding</div>' +
              '<div class="ci-detail">0 = same \u0394 (1 bit) \u2502 10+7b \u2502 110+9b \u2502 1110+12b \u2502 1111+64b</div>' +
              '<div class="ci-example">Regular intervals \u2192 most timestamps encode as a single 0 bit</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }
  return html;
}

function buildXORInsightHtml(p) {
  var totalBits = (p.totalBytes - 18) * 8;
  var bitsPerSample = p.count > 1 ? (totalBits / (p.count - 1)).toFixed(1) : '-';

  return '<div class="codec-insight">' +
    '<div class="ci-title">\uD83E\uDDEC XOR-Delta \u00b7 Gorilla-style Compression <span class="ci-ref">(Facebook/Meta, VLDB 2015)</span></div>' +
    '<div class="ci-pipeline">' +
      '<div class="ci-step">' +
        '<div class="ci-num">\u23F1</div>' +
        '<div class="ci-body">' +
          '<div class="ci-step-title">Timestamps: Delta-of-Delta</div>' +
          '<div class="ci-detail">Base: ' + formatEpochNs(p.firstTs) + '</div>' +
          '<div class="ci-example">0 = same \u0394 (1 bit) \u2502 10+7b \u2502 110+9b \u2502 1110+12b \u2502 1111+64b</div>' +
        '</div>' +
      '</div>' +
      '<div class="ci-step">' +
        '<div class="ci-num">\u2295</div>' +
        '<div class="ci-body">' +
          '<div class="ci-step-title">Values: XOR of IEEE-754 bits</div>' +
          '<div class="ci-detail">Base value: ' + p.firstVal.toPrecision(6) + '</div>' +
          '<div class="ci-example">Similar floats share leading/trailing bits \u2192 only meaningful XOR bits stored</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="ci-exceptions">\uD83D\uDCCA Interleaved stream: ~' + bitsPerSample + ' bits/sample (timestamps + values combined)</div>' +
  '</div>';
}

// ── ALP bit-map builder ──────────────────────────────────────────────
// ALP bit-packing is deterministic: each value occupies exactly bitWidth bits.
// Timestamps use Gorilla delta-of-delta (same as XOR).

function buildALPBitMap(primaryBlob, tsBlob, sampleCount) {
  const bitMap = [];
  const valBlobLen = primaryBlob.byteLength;

  // Parse ALP header
  const alpCount = valBlobLen >= 2 ? (primaryBlob[0] << 8) | primaryBlob[1] : 0;
  const alpExp = valBlobLen >= 3 ? primaryBlob[2] : 0;
  const alpBW = valBlobLen >= 4 ? primaryBlob[3] : 0;
  const alpMin = valBlobLen >= 12 ? readI64BE(primaryBlob, 4) : 0n;
  const alpExc = valBlobLen >= 14 ? (primaryBlob[12] << 8) | primaryBlob[13] : 0;

  // Value bit positions (in the value blob)
  const headerBits = 14 * 8; // 14-byte header
  const bpBytes = Math.ceil(alpCount * alpBW / 8);

  // Decode exception positions
  const excPositions = new Set();
  const excPosStart = 14 + bpBytes;
  for (let e = 0; e < alpExc; e++) {
    const off = excPosStart + e * 2;
    if (off + 1 < valBlobLen) {
      excPositions.add((primaryBlob[off] << 8) | primaryBlob[off + 1]);
    }
  }

  // Decode exception values
  const excValStart = excPosStart + alpExc * 2;
  const excValues = [];
  for (let e = 0; e < alpExc; e++) {
    const off = excValStart + e * 8;
    if (off + 7 < valBlobLen) {
      excValues.push(readF64BE(primaryBlob, off));
    }
  }

  // Build value entries from bit-packed offsets
  const factor = Math.pow(10, alpExp);
  let excIdx = 0;
  for (let i = 0; i < alpCount; i++) {
    const startBit = headerBits + i * alpBW;
    const endBit = headerBits + (i + 1) * alpBW;

    // Read the offset from the bit-packed region
    let offset = 0n;
    if (alpBW > 0) {
      const bitStart = 14 * 8 + i * alpBW;
      for (let b = 0; b < alpBW; b++) {
        const globalBit = bitStart + b;
        const byteIdx = Math.floor(globalBit / 8);
        const bitIdx = 7 - (globalBit % 8);
        if (byteIdx < valBlobLen) {
          offset = (offset << 1n) | BigInt((primaryBlob[byteIdx] >> bitIdx) & 1);
        }
      }
    }

    const isException = excPositions.has(i);
    const decodedValue = isException ? (excValues[excIdx] ?? NaN) : Number(offset + alpMin) / factor;
    if (isException) excIdx++;

    bitMap.push({
      sampleIndex: i,
      type: 'value',
      startBit, endBit,
      encoding: isException ? 'alp-exception' : 'alp-bitpacked',
      decoded: decodedValue,
      offset: Number(offset),
      bitWidth: alpBW,
      isException,
    });
  }

  // Build timestamp entries using Gorilla delta-of-delta decoder
  if (tsBlob && tsBlob.byteLength >= 10) {
    const tsR = new BitReader(tsBlob);
    const tsCount = tsR.readBitsNum(16);
    const firstTs = BigInt.asIntN(64, tsR.readBits(64));

    // First timestamp: raw 80 bits (16 count + 64 ts)
    bitMap.push({
      sampleIndex: 0,
      type: 'timestamp',
      startBit: 0,
      endBit: 80,
      encoding: 'raw',
      decoded: firstTs,
      blobOffset: valBlobLen, // offset in the combined buffer
    });

    let prevTs = firstTs, prevDelta = 0n;
    for (let i = 1; i < tsCount && i < sampleCount; i++) {
      const tsStart = tsR.totalBits;
      let dod;
      let enc;
      if (tsR.readBit() === 0) {
        dod = 0n; enc = 'dod-zero';
      } else if (tsR.readBit() === 0) {
        const zz = tsR.readBitsNum(7);
        dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
        enc = 'dod-7bit';
      } else if (tsR.readBit() === 0) {
        const zz = tsR.readBitsNum(9);
        dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
        enc = 'dod-9bit';
      } else if (tsR.readBit() === 0) {
        const zz = tsR.readBitsNum(12);
        dod = BigInt.asIntN(64, BigInt((zz >>> 1) ^ -(zz & 1)));
        enc = 'dod-12bit';
      } else {
        dod = BigInt.asIntN(64, tsR.readBits(64));
        enc = 'dod-64bit';
      }
      const delta = prevDelta + dod;
      const ts = prevTs + delta;
      prevDelta = delta;
      prevTs = ts;

      bitMap.push({
        sampleIndex: i,
        type: 'timestamp',
        startBit: tsStart,
        endBit: tsR.totalBits,
        encoding: enc,
        decoded: ts,
        dod, delta,
        blobOffset: valBlobLen,
      });
    }
  }

  return bitMap;
}

// ── Byte-to-sample lookup ─────────────────────────────────────────────
// Maps each byte index to the encoded-value entry that owns the majority
// of its bits.  Used by both hex and decimal views for interactivity.

function buildByteLookup(bitMap, totalBytes) {
  if (!bitMap || bitMap.length === 0) return null;

  // For each byte, count how many bits belong to each bitMap entry
  var ownership = new Array(totalBytes); // ownership[byteIdx] = Map<entryIdx, bitCount>

  for (var ei = 0; ei < bitMap.length; ei++) {
    var entry = bitMap[ei];
    var baseOffset = (entry.blobOffset || 0) * 8;
    for (var b = entry.startBit; b < entry.endBit; b++) {
      var globalBit = baseOffset + b;
      var byteIdx = Math.floor(globalBit / 8);
      if (byteIdx >= totalBytes) continue;
      if (!ownership[byteIdx]) ownership[byteIdx] = new Map();
      ownership[byteIdx].set(ei, (ownership[byteIdx].get(ei) || 0) + 1);
    }
  }

  // For each byte pick the entry that owns the most bits
  var lookup = new Array(totalBytes);
  for (var i = 0; i < totalBytes; i++) {
    if (!ownership[i]) continue;
    var bestIdx = -1, bestCount = 0;
    ownership[i].forEach(function(cnt, idx) {
      if (cnt > bestCount) { bestCount = cnt; bestIdx = idx; }
    });
    if (bestIdx >= 0) lookup[i] = bitMap[bestIdx];
  }

  return lookup;
}

// For a given bitMap entry, return the set of byte indices it spans.
function entryByteRange(entry, totalBytes) {
  var baseOffset = (entry.blobOffset || 0) * 8;
  var startByte = Math.floor((baseOffset + entry.startBit) / 8);
  var endByte = Math.ceil((baseOffset + entry.endBit) / 8);
  return { startByte: Math.max(0, startByte), endByte: Math.min(endByte, totalBytes) };
}

// ── Hex Row Renderer ─────────────────────────────────────────────────
// Returns an HTML string for one row (no DOM operations).

function renderHexRowHTML(row, cols, bytes, byteRegion, regions, mode, byteLookup) {
  var startOffset = row * cols;
  var parts = [];

  parts.push('<div class="hex-offset">0x' + startOffset.toString(16).toUpperCase().padStart(4, '0') + '</div>');

  var asciiStr = '';
  for (var col = 0; col < cols; col++) {
    var byteIdx = startOffset + col;
    var cls = 'hex-cell';

    if (byteIdx < bytes.length) {
      var val = bytes[byteIdx];
      var rIdx = byteRegion[byteIdx];
      cls += ' region-' + regions[rIdx].cls;

      var dataAttrs = ' data-offset="' + byteIdx + '" data-region="' + rIdx + '"';

      if (byteLookup && byteLookup[byteIdx]) {
        var blEntry = byteLookup[byteIdx];
        cls += ' hex-mapped';
        cls += blEntry.type === 'timestamp' ? ' hex-ts' : ' hex-val';
        cls += blEntry.sampleIndex % 2 === 0 ? ' hex-sample-even' : ' hex-sample-odd';
        if (byteIdx === 0 || !byteLookup[byteIdx - 1] || byteLookup[byteIdx - 1] !== blEntry) {
          cls += ' hex-boundary';
        }
        dataAttrs += ' data-sample-index="' + blEntry.sampleIndex + '" data-sample-type="' + blEntry.type + '"';
      }

      var content;
      var style = '';
      if (mode === 'hex') {
        content = val.toString(16).toUpperCase().padStart(2, '0');
      } else {
        content = val.toString().padStart(3, ' ');
        style = ' style="font-size:8px"';
      }
      parts.push('<div class="' + cls + '"' + dataAttrs + style + '>' + content + '</div>');
      asciiStr += (val >= 32 && val <= 126) ? String.fromCharCode(val) : '\u00b7';
    } else {
      parts.push('<div class="' + cls + ' region-padding">  </div>');
      asciiStr += ' ';
    }
  }

  parts.push('<div class="hex-ascii">' + asciiStr + '</div>');
  return parts.join('');
}

// ── Interactive Bit View ─────────────────────────────────────────────

function renderBitView(explorer, bytes, byteRegion, regions, sampleCount, codec, bitMap) {
  var scrollContainer = explorer.querySelector('.hex-grid-scroll');
  scrollContainer.style.display = 'none';

  var existing = explorer.querySelector('.bit-view');
  if (existing) existing.remove();

  var container = document.createElement('div');
  container.className = 'bit-view';

  var maxBits = Math.min(bytes.length * 8, 2048);
  var truncated = bytes.length * 8 > maxBits;

  // Build bit-to-sample lookup for click interaction
  var bitLookup = {}; // bitIndex -> bitMap entry
  if (bitMap) {
    for (var mi = 0; mi < bitMap.length; mi++) {
      var entry = bitMap[mi];
      // For ALP values, bits are in the value blob (offset 0 in combined buffer)
      // For timestamps, bits start at blobOffset
      var baseOffset = (entry.blobOffset || 0) * 8;
      for (var b = entry.startBit; b < entry.endBit; b++) {
        bitLookup[baseOffset + b] = entry;
      }
    }
  }

  // Decode panel
  var decodePanel = document.createElement('div');
  decodePanel.className = 'bit-decode-panel';
  decodePanel.style.display = 'none';

  var activeEntry = null;

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
    var baseOffset = (entry.blobOffset || 0) * 8;
    for (var b = entry.startBit; b < entry.endBit; b++) {
      var globalBit = baseOffset + b;
      var el = container.querySelector('.bit[data-bit="' + globalBit + '"]');
      if (el) {
        el.classList.add('bit-highlight');
        el.classList.add(entry.type === 'timestamp' ? 'bit-highlight-ts' : 'bit-highlight-val');
      }
    }

    // Show decode panel
    decodePanel.style.display = '';
    var bits = entry.endBit - entry.startBit;
    var decodedStr;
    if (entry.type === 'timestamp') {
      decodedStr = formatEpochNs(entry.decoded);
    } else {
      decodedStr = typeof entry.decoded === 'number' ? entry.decoded.toPrecision(8) : String(entry.decoded);
    }

    var encodingDesc = '';
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

    var typeIcon = entry.type === 'timestamp' ? '⏱' : '📊';
    var typeLabel = entry.type === 'timestamp' ? 'Timestamp' : 'Value';

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
    var regionHeader = document.createElement('div');
    regionHeader.style.cssText = 'margin:6px 0 4px;font-weight:700;font-size:11px;color:#f59e0b;';
    regionHeader.textContent = '\u2500\u2500 ' + region.name + ' (bytes ' + region.start + '\u2013' + (region.end - 1) + ') \u2500\u2500';
    container.appendChild(regionHeader);

    var regionBytes = bytes.slice(region.start, Math.min(region.end, Math.ceil(maxBits / 8)));
    var bitsPerRow = 64;
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
          bitEl.title = (mapEntry.type === 'timestamp' ? '⏱ ' : '📊 ') + 'Sample #' + mapEntry.sampleIndex;
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

  if (truncated) {
    var note = document.createElement('div');
    note.style.cssText = 'margin-top:8px;color:#94a3b8;font-size:10px;';
    note.textContent = 'Showing first ' + maxBits + ' of ' + (bytes.length * 8) + ' bits...';
    container.appendChild(note);
  }

  // Click handler for bits
  container.addEventListener('click', function(e) {
    var bitEl = e.target.closest('.bit-mapped');
    if (!bitEl) {
      highlightBitRange(null, container);
      return;
    }
    var globalBit = parseInt(bitEl.dataset.bit);
    var entry = bitLookup[globalBit];
    if (entry) {
      highlightBitRange(entry, container);
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
  var insightHtml = '';
  var bitMap = null;

  if (codec === 'alp') {
    var valBlobLen = primaryBlob.byteLength;
    var tsLen = tsBlob ? tsBlob.byteLength : 0;
    var amortizedTsLen = sharedCount > 0 ? Math.round(tsLen / sharedCount) : tsLen;

    var ALP_HDR = Math.min(14, valBlobLen);
    var alpCount = valBlobLen >= 2 ? (primaryBlob[0] << 8) | primaryBlob[1] : 0;
    var alpExp = valBlobLen >= 3 ? primaryBlob[2] : 0;
    var alpBW = valBlobLen >= 4 ? primaryBlob[3] : 0;
    var alpMin = valBlobLen >= 12 ? readI64BE(primaryBlob, 4) : 0n;
    var alpExc = valBlobLen >= 14 ? (primaryBlob[12] << 8) | primaryBlob[13] : 0;

    var bpBytes = Math.ceil(alpCount * alpBW / 8);
    var excPosBytes = alpExc * 2;
    var excValBytes = alpExc * 8;

    var tsCount = 0, firstTs = 0n;
    if (tsBlob && tsBlob.byteLength >= 10) {
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
      var tsHdrEnd = Math.min(10, amortizedTsLen);
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
            var body = amortizedTsLen - 10;
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
    var xorCount = totalBytes >= 2 ? (bytes[0] << 8) | bytes[1] : 0;
    var xorFirstTs = totalBytes >= 10 ? readI64BE(bytes, 2) : 0n;
    var xorFirstVal = totalBytes >= 18 ? readF64BE(bytes, 10) : 0;
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
  const byteRegion = new Uint8Array(bytes.length);
  for (var ri = 0; ri < regions.length; ri++) {
    for (var i = regions[ri].start; i < regions[ri].end; i++) {
      byteRegion[i] = ri;
    }
  }

  // Build byte-to-sample lookup for hex/decimal interactive views
  var byteLookup = buildByteLookup(bitMap, bytes.length);

  var COLS = 32;
  var totalRows = Math.ceil(bytes.length / COLS);
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
      '<div class="hex-grid" id="hexGrid" style="grid-template-columns: 56px repeat(' + COLS + ', 1fr) minmax(60px, auto);"></div>' +
    '</div>' +
    '<div class="hex-decode-panel" id="hexDecodePanel" style="display:none"></div>' +
    '<div id="regionDetail"></div>';

  // Build minimap
  var minimap = explorer.querySelector('#byteMinimap');
  var totalLen = bytes.length;
  regions.forEach(function(r) {
    var seg = document.createElement('div');
    seg.className = 'mm-seg';
    seg.style.width = Math.max(1, ((r.end - r.start) / totalLen) * 100) + '%';
    seg.style.background = r.cls === 'header' ? '#8b5cf6' : r.cls === 'timestamps' ? '#06b6d4' : r.cls === 'exceptions' ? '#f59e0b' : '#10b981';
    seg.title = r.name + ': ' + formatBytes(r.end - r.start);
    seg.addEventListener('click', function() {
      var targetRow = Math.floor(r.start / COLS);
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

  // Build hex grid — batch via innerHTML (single DOM write)
  var grid = explorer.querySelector('#hexGrid');
  var scrollContainer = explorer.querySelector('.hex-grid-scroll');
  var MAX_INITIAL_ROWS = Math.min(totalRows, 100);

  // cellsByOffset: O(1) lookup for highlight instead of querySelector
  var cellsByOffset = {};

  function renderBatch(startRow, count, mode) {
    var htmlParts = [];
    for (var r = startRow; r < startRow + count; r++) {
      htmlParts.push(renderHexRowHTML(r, COLS, bytes, byteRegion, regions, mode, byteLookup));
    }
    return htmlParts.join('');
  }

  function indexCells() {
    cellsByOffset = {};
    var cells = grid.querySelectorAll('.hex-cell[data-offset]');
    for (var i = 0; i < cells.length; i++) {
      cellsByOffset[cells[i].dataset.offset] = cells[i];
    }
  }

  grid.innerHTML = renderBatch(0, MAX_INITIAL_ROWS, 'hex');
  indexCells();

  // Lazy render remaining rows
  var renderedRows = MAX_INITIAL_ROWS;
  var currentMode = 'hex';
  if (totalRows > MAX_INITIAL_ROWS) {
    var sentinel = document.createElement('div');
    sentinel.style.height = '1px';
    sentinel.style.gridColumn = '1 / -1';
    grid.appendChild(sentinel);
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
      if (renderedRows < totalRows && sentinel && sentinel.parentNode) {
        var sRect = sentinel.getBoundingClientRect();
        var cRect = scrollContainer.getBoundingClientRect();
        if (sRect.top < cRect.bottom + 200) {
          var batch = Math.min(50, totalRows - renderedRows);
          grid.removeChild(sentinel);
          grid.insertAdjacentHTML('beforeend', renderBatch(renderedRows, batch, currentMode));
          // Index new cells
          var newCells = grid.querySelectorAll('.hex-cell[data-offset]');
          for (var i = 0; i < newCells.length; i++) {
            var off = newCells[i].dataset.offset;
            if (!cellsByOffset[off]) cellsByOffset[off] = newCells[i];
          }
          renderedRows += batch;
          if (renderedRows < totalRows) grid.appendChild(sentinel);
        }
      }
    });
  });

  var initVF = scrollContainer.clientHeight / Math.max(1, scrollContainer.scrollHeight);
  viewport.style.left = '0%';
  viewport.style.width = Math.max(3, initVF * 100) + '%';

  // View mode switcher
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
        scrollContainer.style.display = '';
        currentMode = mode;
        renderedRows = Math.min(totalRows, 100);
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
  var hexDecodePanel = explorer.querySelector('#hexDecodePanel');
  var activeHexEntry = null;

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
    var range = entryByteRange(entry, bytes.length);
    var highlighted = [];
    for (var bi = range.startByte; bi < range.endByte; bi++) {
      var cell = cellsByOffset[bi];
      if (cell) {
        cell.classList.add('hex-highlight');
        cell.classList.add(entry.type === 'timestamp' ? 'hex-highlight-ts' : 'hex-highlight-val');
        highlighted.push(cell);
      }
    }
    highlightHexSample._prev = highlighted;

    // Show decode info
    hexDecodePanel.style.display = '';
    var bits = entry.endBit - entry.startBit;
    var spanBytes = range.endByte - range.startByte;
    var decodedStr;
    if (entry.type === 'timestamp') {
      decodedStr = formatEpochNs(entry.decoded);
    } else {
      decodedStr = typeof entry.decoded === 'number' ? entry.decoded.toPrecision(8) : String(entry.decoded);
    }

    var encodingDesc = '';
    if (entry.encoding === 'raw') {
      encodingDesc = 'Raw (uncompressed first sample)';
    } else if (entry.encoding === 'dod-zero') {
      encodingDesc = '\u0394\u00b2 = 0 \u2192 prefix <code>0</code> (1 bit)';
    } else if (entry.encoding === 'dod-7bit') {
      encodingDesc = '\u0394\u00b2 \u2264 \u00b164 \u2192 prefix <code>10</code> + 7-bit zigzag';
    } else if (entry.encoding === 'dod-9bit') {
      encodingDesc = '\u0394\u00b2 \u2264 \u00b1256 \u2192 prefix <code>110</code> + 9-bit zigzag';
    } else if (entry.encoding === 'dod-12bit') {
      encodingDesc = '\u0394\u00b2 \u2264 \u00b12048 \u2192 prefix <code>1110</code> + 12-bit zigzag';
    } else if (entry.encoding === 'dod-64bit') {
      encodingDesc = 'Large \u0394\u00b2 \u2192 prefix <code>1111</code> + 64-bit raw';
    } else if (entry.encoding === 'xor-zero') {
      encodingDesc = 'XOR = 0 \u2192 prefix <code>0</code> (identical value)';
    } else if (entry.encoding === 'xor-reuse') {
      encodingDesc = 'XOR reuse window \u2192 prefix <code>10</code> + ' + entry.meaningful + ' meaningful bits';
    } else if (entry.encoding === 'xor-new') {
      encodingDesc = 'XOR new window \u2192 prefix <code>11</code> + 6b leading(' + entry.leading + ') + 6b length(' + entry.meaningful + ') + ' + entry.meaningful + ' bits';
    } else if (entry.encoding === 'alp-bitpacked') {
      encodingDesc = 'ALP bit-packed offset = ' + entry.offset + ' (' + entry.bitWidth + ' bits)';
    } else if (entry.encoding === 'alp-exception') {
      encodingDesc = '\u26a0\ufe0f ALP exception \u2014 stored as raw f64';
    }

    var typeIcon = entry.type === 'timestamp' ? '\u23f1' : '\uD83D\uDCCA';
    var typeLabel = entry.type === 'timestamp' ? 'Timestamp' : 'Value';

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
      '<span class="bt-hex">0x' + val.toString(16).toUpperCase().padStart(2, '0') + '</span>' +
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
}
