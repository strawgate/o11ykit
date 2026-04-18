// ── Pure logic for byte-level chunk exploration ──────────────────────
// No DOM dependencies. Testable in isolation via vitest.

import { readI64BE, readF64BE, formatEpochNs, formatBytes, superNum, formatHexByte } from './utils.js';
import { BitReader } from './codec.js';

export const ALP_HEADER_SIZE = 14;
export const TS_HEADER_SIZE = 10;

// ── ALP Insight HTML ─────────────────────────────────────────────────

export function buildALPInsightHtml(p) {
  const factor = '10' + superNum(p.exponent);
  const excPct = p.count > 0 ? ((p.excCount / p.count) * 100).toFixed(1) : '0';
  const rawValBits = p.count * 64;
  const compValBits = p.bitpackedBytes * 8;
  const valRatio = rawValBits > 0 ? (rawValBits / Math.max(1, compValBits)).toFixed(1) : '-';

  let html =
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

// ── XOR Insight HTML ─────────────────────────────────────────────────

export function buildXORInsightHtml(p) {
  const totalBits = (p.totalBytes - 18) * 8;
  const bitsPerSample = p.count > 1 ? (totalBits / (p.count - 1)).toFixed(1) : '-';

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

// ── ALP header parser ────────────────────────────────────────────────

export function parseALPHeader(blob) {
  const len = blob.byteLength;
  return {
    count: len >= 2 ? (blob[0] << 8) | blob[1] : 0,
    exponent: len >= 3 ? blob[2] : 0,
    bitWidth: len >= 4 ? blob[3] : 0,
    minInt: len >= 12 ? readI64BE(blob, 4) : 0n,
    excCount: len >= ALP_HEADER_SIZE ? (blob[12] << 8) | blob[13] : 0,
  };
}

// ── XOR header parser ────────────────────────────────────────────────

export function parseXORHeader(blob) {
  const len = blob.byteLength;
  return {
    count: len >= 2 ? (blob[0] << 8) | blob[1] : 0,
    firstTs: len >= TS_HEADER_SIZE ? readI64BE(blob, 2) : 0n,
    firstVal: len >= 18 ? readF64BE(blob, 10) : 0,
  };
}

// ── ALP bit-map builder ──────────────────────────────────────────────
// ALP bit-packing is deterministic: each value occupies exactly bitWidth bits.
// Timestamps use Gorilla delta-of-delta (same as XOR).

export function buildALPBitMap(primaryBlob, tsBlob, sampleCount) {
  const bitMap = [];
  const valBlobLen = primaryBlob.byteLength;

  const hdr = parseALPHeader(primaryBlob);
  const { count: alpCount, exponent: alpExp, bitWidth: alpBW, minInt: alpMin, excCount: alpExc } = hdr;

  // Value bit positions (in the value blob)
  const headerBits = ALP_HEADER_SIZE * 8;
  const bpBytes = Math.ceil(alpCount * alpBW / 8);

  // Decode exception positions
  const excPositions = new Set();
  const excPosStart = ALP_HEADER_SIZE + bpBytes;
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
      const bitStart = ALP_HEADER_SIZE * 8 + i * alpBW;
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

  // Add byte-level entries for exception positions and raw values
  // so they are clickable in hex/decimal views
  excIdx = 0;
  const excPosList = [...excPositions];
  for (let e = 0; e < alpExc; e++) {
    const posOff = excPosStart + e * 2;
    const valOff = excValStart + e * 8;
    const sampleIdx = excPosList[e] ?? e;
    const excVal = excValues[e] ?? NaN;

    // Exception position entry (2 bytes = 16 bits)
    if (posOff + 1 < valBlobLen) {
      bitMap.push({
        sampleIndex: sampleIdx,
        type: 'value',
        startBit: posOff * 8,
        endBit: (posOff + 2) * 8,
        encoding: 'alp-exc-position',
        decoded: excVal,
        isException: true,
      });
    }

    // Exception raw value entry (8 bytes = 64 bits)
    if (valOff + 7 < valBlobLen) {
      bitMap.push({
        sampleIndex: sampleIdx,
        type: 'value',
        startBit: valOff * 8,
        endBit: (valOff + 8) * 8,
        encoding: 'alp-exc-rawvalue',
        decoded: excVal,
        isException: true,
      });
    }
  }

  // Build timestamp entries using Gorilla delta-of-delta decoder
  if (tsBlob && tsBlob.byteLength >= TS_HEADER_SIZE) {
    const tsR = new BitReader(tsBlob);
    const tsCount = tsR.readBitsNum(16);
    const firstTs = BigInt.asIntN(64, tsR.readBits(64));

    bitMap.push({
      sampleIndex: 0,
      type: 'timestamp',
      startBit: 0,
      endBit: 80,
      encoding: 'raw',
      decoded: firstTs,
      blobOffset: valBlobLen,
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

// ── Byte-to-sample lookup ────────────────────────────────────────────
// Maps each byte index to the encoded-value entry that owns the majority
// of its bits.

export function buildByteLookup(bitMap, totalBytes) {
  if (!bitMap || bitMap.length === 0) return null;

  const ownership = new Array(totalBytes);

  for (let ei = 0; ei < bitMap.length; ei++) {
    const entry = bitMap[ei];
    const baseOffset = (entry.blobOffset || 0) * 8;
    for (let b = entry.startBit; b < entry.endBit; b++) {
      const globalBit = baseOffset + b;
      const byteIdx = Math.floor(globalBit / 8);
      if (byteIdx >= totalBytes) continue;
      if (!ownership[byteIdx]) ownership[byteIdx] = new Map();
      ownership[byteIdx].set(ei, (ownership[byteIdx].get(ei) || 0) + 1);
    }
  }

  const lookup = new Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) {
    if (!ownership[i]) continue;
    let bestIdx = -1, bestCount = 0;
    ownership[i].forEach(function(cnt, idx) {
      if (cnt > bestCount) { bestCount = cnt; bestIdx = idx; }
    });
    if (bestIdx >= 0) lookup[i] = bitMap[bestIdx];
  }

  return lookup;
}

// ── Entry byte range ─────────────────────────────────────────────────
// For a given bitMap entry, return the byte range it spans.

export function entryByteRange(entry, totalBytes) {
  const baseOffset = (entry.blobOffset || 0) * 8;
  const startByte = Math.floor((baseOffset + entry.startBit) / 8);
  const endByte = Math.ceil((baseOffset + entry.endBit) / 8);
  return { startByte: Math.max(0, startByte), endByte: Math.min(endByte, totalBytes) };
}

// ── Byte region map builder ──────────────────────────────────────────
// Maps each byte index to its region index.

export function buildByteRegionMap(regions, totalBytes) {
  const byteRegion = new Uint8Array(totalBytes);
  for (let ri = 0; ri < regions.length; ri++) {
    for (let i = regions[ri].start; i < regions[ri].end; i++) {
      if (i < totalBytes) byteRegion[i] = ri;
    }
  }
  return byteRegion;
}

// ── Hex row HTML renderer ────────────────────────────────────────────
// Returns an HTML string for one row (no DOM operations).

export function renderHexRowHTML(row, cols, bytes, byteRegion, regions, mode, byteLookup) {
  const startOffset = row * cols;
  const parts = [];

  parts.push('<div class="hex-offset">0x' + startOffset.toString(16).toUpperCase().padStart(4, '0') + '</div>');

  let asciiStr = '';
  for (let col = 0; col < cols; col++) {
    const byteIdx = startOffset + col;
    let cls = 'hex-cell';

    if (byteIdx < bytes.length) {
      const val = bytes[byteIdx];
      const rIdx = byteRegion[byteIdx];
      cls += ' region-' + regions[rIdx].cls;

      let dataAttrs = ' data-offset="' + byteIdx + '" data-region="' + rIdx + '"';

      if (byteLookup && byteLookup[byteIdx]) {
        const blEntry = byteLookup[byteIdx];
        cls += ' hex-mapped';
        cls += blEntry.type === 'timestamp' ? ' hex-ts' : ' hex-val';
        cls += blEntry.sampleIndex % 2 === 0 ? ' hex-sample-even' : ' hex-sample-odd';
        if (byteIdx === 0 || !byteLookup[byteIdx - 1] || byteLookup[byteIdx - 1] !== blEntry) {
          cls += ' hex-boundary';
        }
        dataAttrs += ' data-sample-index="' + blEntry.sampleIndex + '" data-sample-type="' + blEntry.type + '"';
      }

      let content;
      let style = '';
      if (mode === 'hex') {
        content = formatHexByte(val);
      } else {
        content = val.toString().padStart(3, ' ');
        style = ' style="font-size:8px"';
      }
      parts.push('<div class="' + cls + '"' + dataAttrs + style + '>' + content + '</div>');
      if (val >= 32 && val <= 126) {
        if (val === 38) asciiStr += '&amp;';
        else if (val === 60) asciiStr += '&lt;';
        else if (val === 62) asciiStr += '&gt;';
        else asciiStr += String.fromCharCode(val);
      } else {
        asciiStr += '\u00b7';
      }
    } else {
      parts.push('<div class="' + cls + ' region-padding">  </div>');
      asciiStr += ' ';
    }
  }

  parts.push('<div class="hex-ascii">' + asciiStr + '</div>');
  return parts.join('');
}

// ── Encoding description ─────────────────────────────────────────────
// Pure function: returns a human-readable description for a bitMap entry's encoding.

export function encodingDescription(entry) {
  if (entry.encoding === 'raw') return 'Raw (uncompressed first sample)';
  if (entry.encoding === 'dod-zero') return '\u0394\u00b2 = 0 \u2192 prefix <code>0</code> (1 bit)';
  if (entry.encoding === 'dod-7bit') return '\u0394\u00b2 \u2264 \u00b164 \u2192 prefix <code>10</code> + 7-bit zigzag';
  if (entry.encoding === 'dod-9bit') return '\u0394\u00b2 \u2264 \u00b1256 \u2192 prefix <code>110</code> + 9-bit zigzag';
  if (entry.encoding === 'dod-12bit') return '\u0394\u00b2 \u2264 \u00b12048 \u2192 prefix <code>1110</code> + 12-bit zigzag';
  if (entry.encoding === 'dod-64bit') return 'Large \u0394\u00b2 \u2192 prefix <code>1111</code> + 64-bit raw';
  if (entry.encoding === 'xor-zero') return 'XOR = 0 \u2192 prefix <code>0</code> (identical value)';
  if (entry.encoding === 'xor-reuse') return 'XOR reuse window \u2192 prefix <code>10</code> + ' + entry.meaningful + ' meaningful bits';
  if (entry.encoding === 'xor-new') return 'XOR new window \u2192 prefix <code>11</code> + 6b leading(' + entry.leading + ') + 6b length(' + entry.meaningful + ') + ' + entry.meaningful + ' bits';
  if (entry.encoding === 'alp-bitpacked') return 'ALP bit-packed offset = ' + entry.offset + ' (' + entry.bitWidth + ' bits)';
  if (entry.encoding === 'alp-exception') return '\u26a0\ufe0f ALP exception \u2014 stored as raw f64';
  if (entry.encoding === 'alp-exc-position') return '\u26a0\ufe0f Exception position (u16 BE index)';
  if (entry.encoding === 'alp-exc-rawvalue') return '\u26a0\ufe0f Exception raw value (f64 BE IEEE-754)';
  return '';
}
