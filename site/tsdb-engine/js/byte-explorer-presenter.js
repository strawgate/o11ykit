// @ts-nocheck

import { encodingDescription } from "./byte-explorer-logic.js";
import { escapeHtml, formatDuration, formatEpochNs, superNum } from "./utils.js";

export function formatNsDuration(ns) {
  const sign = ns < 0n ? "-" : "";
  const absNs = ns < 0n ? -ns : ns;
  const ms = Number(absNs) / 1_000_000;
  if (!Number.isFinite(ms)) return `${sign}${absNs.toString()} ns`;
  if (ms < 1) return `${sign}${absNs.toString()} ns`;
  return `${sign}${formatDuration(Math.round(ms))}`;
}

export function buildEmptyDecodeHTML(kind = "byte") {
  const label = kind === "timestamp" ? "timestamp byte" : "value byte";
  return (
    '<div class="bdp-placeholder">' +
    `<div class="bdp-placeholder-title">Select a ${label}</div>` +
    '<div class="bdp-placeholder-copy">Tap any highlighted byte in the grid to inspect how it decodes.</div>' +
    "</div>"
  );
}

export function formatDecodedValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toFixed(0);
  const fixed = Math.abs(value) >= 1 ? value.toFixed(6) : value.toPrecision(6);
  return fixed.replace(/(\.\d*?[1-9])0+$/u, "$1").replace(/\.0+$/u, "");
}

export function buildRegionDecodeHTML(region) {
  const byteLabel =
    region.end - region.start <= 1
      ? `byte ${region.start}`
      : `bytes ${region.start}-${region.end - 1}`;
  const sections = String(region.decode())
    .split(/\n\n+/u)
    .map((block) => block.trim())
    .filter(Boolean);
  const body = sections
    .map((block) => `<div class="bdp-note">${escapeHtml(block).replace(/\n/g, "<br>")}</div>`)
    .join("");
  return (
    '<div class="bdp-header bdp-header-compact">' +
    `<span class="bdp-sample-primary">${escapeHtml(region.name)}</span>` +
    `<span class="bdp-bits">${byteLabel}</span>` +
    "</div>" +
    '<div class="bdp-math">' +
    body +
    "</div>"
  );
}

export function buildEntryDecodeHTML(entry, spanDesc) {
  const entryBits = entry.endBit - entry.startBit;
  const isAlpValue = entry.encoding === "alp-bitpacked";
  const isAlpException = entry.encoding === "alp-exception";
  const decodedStr =
    entry.type === "timestamp" ? formatEpochNs(entry.decoded) : formatDecodedValue(entry.decoded);
  const enc = encodingDescription(entry);
  const typeIcon = entry.type === "timestamp" ? "\u23f1" : "\uD83D\uDCCA";
  const typeLabel = entry.type === "timestamp" ? "Timestamp" : "Value";
  let mathRows = "";

  if (entry.encoding === "alp-bitpacked") {
    const factor = `10${superNum(entry.exponent ?? 0)}`;
    const scale = 10 ** (entry.exponent ?? 0);
    const minDecoded = Number(entry.minInt) / 10 ** (entry.exponent ?? 0);
    const minDecodedStr = formatDecodedValue(minDecoded);
    const offsetDecoded = entry.offset / scale;
    const offsetDecodedStr = formatDecodedValue(offsetDecoded);
    const explanation =
      entry.offset === 0
        ? `ALP uses ${minDecodedStr} as the chunk's starting value. This sample is exactly the same as that starting value, so it can store 0 and decode back to ${decodedStr}. In this chunk, that offset fits in ${entry.bitWidth} bits instead of storing a full 64-bit floating-point value.`
        : `ALP uses ${minDecodedStr} as the chunk's starting value. Instead of storing ${decodedStr} directly, it stores the difference: ${offsetDecodedStr}. Add that difference back to ${minDecodedStr}, and you get ${decodedStr}. In this chunk, that difference fits in ${entry.bitWidth} bits instead of storing a full 64-bit floating-point value.`;
    const scaleNote =
      entry.exponent && entry.exponent !== 0
        ? `Because these values have decimals, ALP briefly turns them into whole numbers by multiplying by ${factor}. After decoding, it divides by ${factor} to get back to the original value.`
        : "Because these values are whole numbers already, the packed offset maps directly back to the final value.";
    mathRows =
      '<div class="bdp-math">' +
      `<div class="bdp-note">${explanation}</div>` +
      `<div class="bdp-note">${scaleNote}</div>` +
      "</div>";
  }

  if (entry.encoding === "alp-exception") {
    const exceptionNote = Number.isFinite(entry.decoded)
      ? `This sample did not fit the packed offset stream cleanly, so ALP stores the full floating-point value ${decodedStr} directly for this datapoint.`
      : "This sample did not fit the packed offset stream cleanly, so ALP stores the full floating-point value directly for this datapoint.";
    mathRows =
      '<div class="bdp-math">' +
      `<div class="bdp-note">${exceptionNote}</div>` +
      `<div class="bdp-note">That means this sample uses the full 64-bit value here instead of the smaller packed form used by most values in the chunk.</div>` +
      "</div>";
  }

  if (entry.type === "timestamp") {
    if (entry.isBaseTimestamp) {
      mathRows =
        '<div class="bdp-math">' +
        `<div class="bdp-note">This is the first timestamp in the chunk, so it is stored in full as ${decodedStr}.</div>` +
        '<div class="bdp-note">Later timestamps can store just the change in spacing from this starting point.</div>' +
        "</div>";
    } else if (
      entry.prevTs !== undefined &&
      entry.prevDelta !== undefined &&
      entry.dod !== undefined
    ) {
      const prevTsStr = formatEpochNs(entry.prevTs);
      const dodStr = formatNsDuration(entry.dod);
      const deltaStr = formatNsDuration(entry.delta);
      const explanation =
        entry.prevDelta === 0n
          ? `The first full timestamp was ${prevTsStr}. This datapoint establishes an interval of ${deltaStr}, so adding ${deltaStr} gives ${decodedStr}.`
          : entry.dod === 0n
            ? `The previous timestamp was ${prevTsStr}, with datapoints arriving every ${deltaStr}. This datapoint came in at exactly that same interval, so its timestamp only needs ${entryBits} bit${entryBits === 1 ? "" : "s"} to store.`
            : `The previous timestamp was ${prevTsStr}, with datapoints arriving every ${formatNsDuration(entry.prevDelta)}. This datapoint shifted that interval by ${dodStr}, so the new interval becomes ${deltaStr}. Add that new interval to ${prevTsStr}, and you get ${decodedStr}.`;
      const compressionNote =
        entry.prevDelta === 0n
          ? `Instead of storing a full timestamp again, the chunk stores just this first interval, which takes ${entryBits} bits here.`
          : entry.encoding === "dod-zero"
            ? "Because the spacing did not change, the chunk stores a tiny repeat marker instead of another full timestamp."
            : `Instead of storing a full timestamp again, the chunk stores just the interval change, which takes ${entryBits} bits here.`;
      mathRows =
        '<div class="bdp-math">' +
        `<div class="bdp-note">${explanation}</div>` +
        `<div class="bdp-note">${compressionNote}</div>` +
        "</div>";
    }
  }

  const headerHtml =
    isAlpValue || isAlpException
      ? '<div class="bdp-header bdp-header-compact">' +
        `<span class="bdp-sample-primary">Sample #${entry.sampleIndex} value is ${decodedStr}</span>` +
        `<span class="bdp-bits">${spanDesc}</span>` +
        "</div>"
      : '<div class="bdp-header">' +
        `<span class="bdp-type ${entry.type}">${typeIcon} ${typeLabel}</span>` +
        `<span class="bdp-sample">Sample #${entry.sampleIndex}</span>` +
        `<span class="bdp-bits">${spanDesc}</span>` +
        "</div>";

  return (
    headerHtml +
    (isAlpValue || isAlpException ? "" : `<div class="bdp-value">${decodedStr}</div>`) +
    (isAlpValue || isAlpException || entry.type === "timestamp" || !enc
      ? ""
      : `<div class="bdp-encoding">${enc}</div>`) +
    mathRows +
    (entry.type === "timestamp"
      ? ""
      : entry.dod !== undefined
        ? `<div class="bdp-detail">\u0394\u00b2 = ${formatNsDuration(entry.dod)}, \u0394 = ${formatNsDuration(entry.delta)}</div>`
        : "") +
    (entry.xor !== undefined && entry.xor !== 0n
      ? `<div class="bdp-detail">XOR = 0x${entry.xor.toString(16).padStart(16, "0")}</div>`
      : "")
  );
}

export function buildByteTooltipHTML({ offset, value, mode, regionName, entry }) {
  if (!entry) {
    return (
      `<div class="bt-headline">${escapeHtml(regionName)}</div>` +
      `<div class="bt-rendered">Byte ${offset} is shown here as ${mode === "hex" ? `0x${value}` : value}.</div>`
    );
  }

  const decodedLabel =
    entry.type === "timestamp" ? formatEpochNs(entry.decoded) : formatDecodedValue(entry.decoded);
  const headline =
    `<div class="bt-headline">Sample #${entry.sampleIndex}` +
    (entry.type === "timestamp" ? " timestamp is " : " value is ") +
    `${decodedLabel}</div>`;

  let detail = "";
  if (entry.type === "value") {
    if (entry.encoding === "alp-bitpacked") {
      const diff = formatDecodedValue(entry.offset / 10 ** (entry.exponent ?? 0));
      const baseline = formatDecodedValue(Number(entry.minInt) / 10 ** (entry.exponent ?? 0));
      detail =
        `<div class="bt-rendered">The chunk baseline is ${baseline}. ` +
        `This sample stores a difference of ${diff}, which takes up ${entry.bitWidth ?? entry.endBit - entry.startBit} bits.</div>`;
    } else if (entry.encoding === "alp-exception") {
      detail =
        '<div class="bt-rendered">This value did not compress cleanly, so it is stored as a raw 64-bit float.</div>';
    } else {
      detail =
        '<div class="bt-rendered">This byte belongs to the stored value for this sample.</div>';
    }
  } else if (entry.type === "timestamp") {
    const bitsUsed = entry.endBit - entry.startBit;
    if (entry.isBaseTimestamp) {
      detail =
        '<div class="bt-rendered">This is the starting timestamp for the chunk, so it is stored in full.</div>';
    } else if (entry.encoding === "dod-zero") {
      detail =
        '<div class="bt-rendered">This timestamp keeps the same interval as the previous point and only takes 1 bit to store.</div>';
    } else {
      detail = `<div class="bt-rendered">This timestamp stores an interval change instead of a full timestamp and takes ${bitsUsed} bits here.</div>`;
    }
  }

  return headline + detail;
}
