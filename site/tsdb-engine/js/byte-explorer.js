// ── Interactive Byte Explorer ──────────────────────────────────────

import {
  renderHexContent,
  setupHexInteraction,
  setupViewModeButtons,
} from "./byte-explorer-hex-view.js";
import {
  ALP_HEADER_SIZE,
  buildALPBitMap,
  buildALPInsightHtml,
  buildByteLookup,
  buildByteRegionMap,
  buildXORInsightHtml,
  parseALPHeader,
  parseXORHeader,
  TS_HEADER_SIZE,
} from "./byte-explorer-logic.js";
import { buildRegionDecodeHTML } from "./byte-explorer-presenter.js";
import { getRegionSwatchColor, mountExplorerShell, renderMinimap } from "./byte-explorer-view.js";
import { BitReader, decodeChunkAnnotated } from "./codec.js";
import { $, formatBytes, formatEpochNs, readI64BE, superNum } from "./utils.js";

// ── Explorer shell helpers ───────────────────────────────────────────

function _buildExplorerShell(explorer, bytes, _insightHtml) {
  mountExplorerShell(explorer, {
    title: "Byte Explorer",
    bytesLength: bytes.length,
    minimapId: "byteMinimap",
    gridId: "hexGrid",
    decodePanelId: "hexDecodePanel",
    emptyKind: "byte",
  });
}

function _buildMinimap(explorer, bytes, regions, showRegionDetail) {
  var minimap = explorer.querySelector("#byteMinimap");
  return renderMinimap(minimap, {
    totalBytes: bytes.length,
    regions,
    getColor: getRegionSwatchColor,
    onRegionClick: (r) => {
      var targetRow = Math.floor(r.start / HEX_COLS);
      var gridEl = explorer.querySelector(".hex-grid-scroll");
      var rowEls = gridEl.querySelectorAll(".hex-offset");
      if (rowEls[targetRow])
        rowEls[targetRow].scrollIntoView({ behavior: "smooth", block: "start" });
      showRegionDetail(r);
    },
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
  var _insightHtml = "";
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
        "This header tells ALP how to decode every value in the chunk." +
        "\n\nSample count: " +
        alpCount +
        "\nDecimal scale: \u00d7" +
        factor10 +
        " before packing" +
        "\nBits per stored offset: " +
        alpBW +
        "\nFloor value (stored as an integer): " +
        alpMin.toString() +
        "\nExceptions stored separately: " +
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
          "This section holds the packed offsets for each value in the chunk." +
          "\n\n" +
          alpCount +
          " values \u00d7 " +
          alpBW +
          " bits = " +
          bpBytes +
          " bytes" +
          "\nEach stored number says how far above the chunk floor a sample sits." +
          "\nTo reconstruct a value: add the offset back to the floor, then scale by " +
          factor10 +
          ".",
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
          "These bytes point to the rare values that could not be packed as normal ALP offsets." +
          "\n\nThere are " +
          alpExc +
          " exception positions stored here.",
      });
      regions.push({
        name: "Exception Raw Values",
        cls: "exceptions",
        start: epEnd,
        end: evEnd,
        decode: () =>
          "These are the raw floating-point values for those exceptions." +
          "\n\nThey are kept verbatim so the chunk can still decode losslessly.",
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
          "This header sets up the shared timestamp stream for the chunk." +
          "\n\nTimestamp count: " +
          tsCount +
          "\nFirst timestamp: " +
          formatEpochNs(firstTs),
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
              "These bytes store the rest of the timestamps as changes from the previous spacing." +
              "\n\nBody size: " +
              body +
              " bytes" +
              "\nFull shared blob: " +
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

    _insightHtml = buildALPInsightHtml({
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
        "This header stores the first full timestamp and first full value for the chunk." +
        "\n\nSample count: " +
        xorCount +
        "\nFirst timestamp: " +
        formatEpochNs(xorFirstTs) +
        "\nFirst value: " +
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
          "This body interleaves timestamp changes and value changes for the remaining samples." +
          "\n\nBody size: " +
          streamBytes +
          " bytes for " +
          (xorCount - 1) +
          " samples" +
          "\nAverage cost: ~" +
          bps +
          " bits per sample"
        );
      },
    });

    _insightHtml = buildXORInsightHtml({
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

  var totalRows = Math.ceil(bytes.length / 32);

  function showRegionDetail(region) {
    var decodePanel = explorer.querySelector("#hexDecodePanel");
    if (!decodePanel) return;
    decodePanel.innerHTML = buildRegionDecodeHTML(region);
  }

  _buildExplorerShell(explorer, bytes, "");
  var viewport = _buildMinimap(explorer, bytes, regions, showRegionDetail);
  var hexContent = renderHexContent({
    gridEl: explorer.querySelector(".hex-grid"),
    scrollContainer: explorer.querySelector(".hex-grid-scroll"),
    bytes,
    byteRegion,
    regions,
    byteLookup,
    totalRows,
    viewport,
  });
  var highlightHexSample = setupHexInteraction({
    explorer,
    bytes,
    byteRegion,
    regions,
    byteLookup,
    hexContent,
    showRegionDetail,
    setEscapeHandler(handler) {
      renderByteExplorer._escHandler = handler;
      document.addEventListener("keydown", renderByteExplorer._escHandler);
    },
  });
  setupViewModeButtons({ explorer, bytes, regions, bitMap, hexContent, highlightHexSample });
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
      "This header stores the first full timestamp for the shared timestamp stream." +
      "\n\nTimestamp count: " +
      tsCount +
      "\nFirst timestamp: " +
      formatEpochNs(firstTs),
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
          "These bytes store the remaining timestamps as changes from the previous spacing." +
          "\n\nBody size: " +
          body +
          " bytes"
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
      isBaseTimestamp: true,
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
      var priorTs = prevTs;
      var priorDelta = prevDelta;
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
        prevTs: priorTs,
        prevDelta: priorDelta,
      });
    }
    bitMap = tsBitMap;
  } catch (e) {
    console.warn("Timestamp bit map failed:", e);
  }

  var byteRegion = buildByteRegionMap(regions, totalBytes);
  var byteLookup = buildByteLookup(bitMap, totalBytes);
  var totalRows = Math.ceil(totalBytes / 32);

  function showRegionDetail(region) {
    var decodePanel = explorer.querySelector("#hexDecodePanelTs");
    if (!decodePanel) return;
    decodePanel.innerHTML = buildRegionDecodeHTML(region);
  }

  mountExplorerShell(explorer, {
    title: "Timestamp Explorer",
    bytesLength: totalBytes,
    minimapId: "byteMinimapTs",
    gridId: "hexGridTs",
    decodePanelId: "hexDecodePanelTs",
    emptyKind: "timestamp",
  });
  var viewport = renderMinimap(explorer.querySelector(".byte-minimap"), {
    totalBytes,
    regions,
    getColor: () => "#06b6d4",
    onRegionClick: showRegionDetail,
  });

  var hexContent = renderHexContent({
    gridEl: explorer.querySelector(".hex-grid"),
    scrollContainer: explorer.querySelector(".hex-grid-scroll"),
    bytes,
    byteRegion,
    regions,
    byteLookup,
    totalRows,
    viewport,
  });
  var highlightHexSample = setupHexInteraction({
    explorer,
    bytes,
    byteRegion,
    regions,
    byteLookup,
    hexContent,
    showRegionDetail,
    setEscapeHandler(handler) {
      renderByteExplorer._escHandler = handler;
      document.addEventListener("keydown", renderByteExplorer._escHandler);
    },
  });
  setupViewModeButtons({ explorer, bytes, regions, bitMap, hexContent, highlightHexSample });
}
