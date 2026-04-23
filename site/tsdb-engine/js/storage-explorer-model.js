// @ts-check

/** @typedef {import("../site-types").ByteSegment} ByteSegment */
/** @typedef {import("../site-types").RandomChunkPick} RandomChunkPick */
/** @typedef {import("../site-types").RandomPickSeriesInfo} RandomPickSeriesInfo */

import { ALP_HEADER_SIZE } from "./byte-explorer-logic.js";

/**
 * @param {RandomPickSeriesInfo[]} seriesInfos
 * @param {() => number} [random]
 * @returns {RandomChunkPick | null}
 */
export function pickRandomChunk(seriesInfos, random = Math.random) {
  /** @type {RandomChunkPick[]} */
  const frozenPicks = [];
  /** @type {RandomChunkPick[]} */
  const hotPicks = [];
  for (const si of seriesInfos) {
    for (let i = 0; i < si.info.frozen.length; i++) {
      frozenPicks.push({ si, chunkIndex: i, type: "frozen" });
    }
    if (si.info.hot.count > 0) hotPicks.push({ si, chunkIndex: -1, type: "hot" });
  }
  const picks = frozenPicks.length > 0 ? frozenPicks : hotPicks;
  if (picks.length === 0) return null;
  const index = Math.floor(random() * picks.length);
  return picks[index] ?? null;
}

/**
 * @param {Uint8Array} compressed
 * @returns {{ totalBytes: number, segments: ByteSegment[] }}
 */
export function buildXorByteSegments(compressed) {
  const totalBytes = compressed.byteLength;
  const headerBytes = Math.min(16, totalBytes);
  const remainingBytes = totalBytes - headerBytes;
  const tsDeltaBytes = Math.round(remainingBytes * 0.25);
  const valXorBytes = remainingBytes - tsDeltaBytes;
  return {
    totalBytes,
    segments: [
      { label: "Header", bytes: headerBytes, cls: "header" },
      { label: "Timestamps", bytes: tsDeltaBytes, cls: "timestamps" },
      { label: "XOR Values", bytes: valXorBytes, cls: "values" },
    ],
  };
}

/**
 * @param {Uint8Array} compressedValues
 * @returns {{ totalBytes: number, segments: ByteSegment[] }}
 */
export function buildAlpByteSegments(compressedValues) {
  const valBytes = compressedValues.byteLength;
  const alpBW = valBytes >= 4 ? (compressedValues[3] ?? 0) : 0;
  const alpCount =
    valBytes >= 2 ? ((compressedValues[0] ?? 0) << 8) | (compressedValues[1] ?? 0) : 0;
  const alpExc =
    valBytes >= ALP_HEADER_SIZE
      ? ((compressedValues[12] ?? 0) << 8) | (compressedValues[13] ?? 0)
      : 0;
  const headerBytes = Math.min(ALP_HEADER_SIZE, valBytes);
  const remainingBytes = Math.max(0, valBytes - headerBytes);
  const bpBytes = Math.min(remainingBytes, Math.ceil((alpCount * alpBW) / 8));
  const excBytes = Math.min(Math.max(0, remainingBytes - bpBytes), alpExc * 10);

  /** @type {ByteSegment[]} */
  const segments = [
    { label: "Header", bytes: headerBytes, cls: "header" },
    { label: "Offsets", bytes: bpBytes, cls: "values" },
  ];
  if (excBytes > 0) segments.push({ label: "Exceptions", bytes: excBytes, cls: "exceptions" });

  return {
    totalBytes: valBytes,
    segments,
  };
}

/**
 * @param {Uint8Array} tsBlob
 * @returns {{ totalBytes: number, segments: ByteSegment[] }}
 */
export function buildTimestampByteSegments(tsBlob) {
  const totalBytes = tsBlob.byteLength;
  const headerBytes = Math.min(10, totalBytes);
  const bodyBytes = totalBytes - headerBytes;
  return {
    totalBytes,
    segments: [
      { label: "Header", bytes: headerBytes, cls: "timestamps" },
      { label: "Δ² Body", bytes: bodyBytes, cls: "timestamps" },
    ],
  };
}
