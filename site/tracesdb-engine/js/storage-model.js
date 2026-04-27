// @ts-nocheck
// ── Storage Model — Compute storage statistics for trace data ───────
// Models chunks, compression ratios, bloom filter stats, and byte layout.

const CHUNK_SIZE = 1024;

/**
 * Organize spans into a columnar storage model for visualization.
 */
export function buildStorageModel(spans, serviceNames) {
  const byService = new Map();
  for (const name of serviceNames) {
    byService.set(name, []);
  }

  for (const span of spans) {
    const svc = getSpanService(span);
    if (byService.has(svc)) {
      byService.get(svc).push(span);
    } else {
      if (!byService.has("unknown")) byService.set("unknown", []);
      byService.get("unknown").push(span);
    }
  }

  const streams = [];
  for (const [service, svcSpans] of byService) {
    const byOp = new Map();
    for (const span of svcSpans) {
      const key = span.name;
      if (!byOp.has(key)) byOp.set(key, []);
      byOp.get(key).push(span);
    }

    for (const [opName, opSpans] of byOp) {
      const chunks = buildChunks(opSpans);
      streams.push({ service, operation: opName, spans: opSpans, chunks });
    }
  }

  const totalChunks = streams.reduce((a, s) => a + s.chunks.length, 0);
  const frozenChunks = streams.reduce((a, s) => a + s.chunks.filter((c) => c.frozen).length, 0);
  const hotChunks = totalChunks - frozenChunks;

  const rawBytes = estimateRawBytes(spans);
  const encodedBytes = estimateEncodedBytes(spans);
  const compressionRatio = rawBytes > 0 ? rawBytes / encodedBytes : 1;

  const bloomStats = computeBloomStats(streams);

  return {
    streams,
    stats: {
      totalSpans: spans.length,
      totalChunks,
      frozenChunks,
      hotChunks,
      rawBytes,
      encodedBytes,
      compressionRatio,
      bytesPerSpan: spans.length > 0 ? Math.round(encodedBytes / spans.length) : 0,
      bloomFPR: bloomStats.fpr,
      bloomBits: bloomStats.totalBits,
      bloomSetBits: bloomStats.setBits,
    },
  };
}

function buildChunks(spans) {
  const chunks = [];
  for (let i = 0; i < spans.length; i += CHUNK_SIZE) {
    const slice = spans.slice(i, i + CHUNK_SIZE);
    const isFull = slice.length === CHUNK_SIZE;
    chunks.push({
      index: chunks.length,
      spans: slice,
      frozen: isFull,
      size: slice.length,
      sections: buildChunkSections(slice),
      bloom: buildBloomFilter(slice),
    });
  }
  return chunks;
}

/**
 * Build section breakdown for a chunk (simulated columnar layout).
 */
function buildChunkSections(spans) {
  const count = spans.length;
  return [
    { name: "Timestamps", color: "var(--region-timestamps)", bytes: count * 8 },
    { name: "Durations", color: "var(--region-durations)", bytes: count * 8 },
    { name: "Trace IDs", color: "var(--region-ids)", bytes: count * 16 },
    { name: "Span IDs", color: "var(--region-ids)", bytes: count * 8 },
    { name: "Parent IDs", color: "var(--region-ids)", bytes: count * 8 },
    {
      name: "Span Names",
      color: "var(--region-names)",
      bytes: estimateStringColumn(spans, "name"),
    },
    { name: "Status", color: "var(--region-status)", bytes: count },
    { name: "Kind", color: "var(--region-kind)", bytes: count },
    { name: "Attributes", color: "var(--region-attributes)", bytes: estimateAttrsBytes(spans) },
    { name: "Events", color: "var(--region-events)", bytes: estimateEventsBytes(spans) },
    { name: "Links", color: "var(--region-links)", bytes: count * 2 },
    { name: "Bloom Filter", color: "var(--region-bloom)", bytes: Math.ceil((count * 10) / 8) },
  ];
}

function estimateStringColumn(spans, key) {
  const unique = new Set(spans.map((s) => s[key] || ""));
  const dictSize = [...unique].reduce((a, s) => a + s.length, 0);
  return dictSize + spans.length * 2;
}

function estimateAttrsBytes(spans) {
  let total = 0;
  for (const span of spans) {
    if (!span.attributes) continue;
    for (const attr of span.attributes) {
      total += (attr.key?.length || 0) + (String(attr.value)?.length || 0) + 4;
    }
  }
  return Math.round(total * 0.6);
}

function estimateEventsBytes(spans) {
  let total = 0;
  for (const span of spans) {
    if (!span.events) continue;
    for (const evt of span.events) {
      total += 8 + (evt.name?.length || 0);
      if (evt.attributes) {
        for (const a of evt.attributes) {
          total += (a.key?.length || 0) + (String(a.value)?.length || 0);
        }
      }
    }
  }
  return Math.round(total * 0.7);
}

function estimateRawBytes(spans) {
  let total = 0;
  for (const span of spans) {
    total += 16 + 8 + 8 + 8 + 8;
    total += (span.name?.length || 0) * 2;
    total += 1 + 1;
    if (span.attributes) {
      for (const a of span.attributes) {
        total += (a.key?.length || 0) * 2 + 32;
      }
    }
    if (span.events) total += span.events.length * 200;
  }
  return total;
}

function estimateEncodedBytes(spans) {
  return Math.round(estimateRawBytes(spans) * 0.35);
}

/** Simple bloom filter simulation */
function buildBloomFilter(spans) {
  const numBits = Math.max(64, spans.length * 10);
  const bits = new Uint8Array(Math.ceil(numBits / 8));
  let setBitCount = 0;

  for (const span of spans) {
    const keys = [span.name, getSpanService(span)];
    for (const key of keys) {
      if (!key) continue;
      const positions = bloomHashes(key, numBits);
      for (const pos of positions) {
        const byteIdx = pos >> 3;
        const bitIdx = pos & 7;
        if (!(bits[byteIdx] & (1 << bitIdx))) {
          bits[byteIdx] |= 1 << bitIdx;
          setBitCount++;
        }
      }
    }
  }

  return { bits, numBits, setBitCount };
}

function bloomHashes(key, numBits) {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < key.length; i++) {
    h1 = (h1 * 31 + key.charCodeAt(i)) | 0;
    h2 = (h2 * 37 + key.charCodeAt(i)) | 0;
  }
  return [Math.abs(h1) % numBits, Math.abs(h2) % numBits, Math.abs(h1 + h2) % numBits];
}

function computeBloomStats(streams) {
  let totalBits = 0;
  let setBits = 0;
  for (const stream of streams) {
    for (const chunk of stream.chunks) {
      totalBits += chunk.bloom.numBits;
      setBits += chunk.bloom.setBitCount;
    }
  }
  const ratio = totalBits > 0 ? setBits / totalBits : 0;
  const fpr = ratio ** 3;
  return { totalBits, setBits, fpr };
}

function getSpanService(span) {
  if (!span.attributes) return "unknown";
  const attr = span.attributes.find((a) => a.key === "service.name");
  return attr ? attr.value : "unknown";
}

/**
 * Build byte data for hex explorer visualization.
 * Returns simulated byte array with section metadata.
 */
export function buildByteExplorerData(chunk) {
  if (!chunk?.sections) return { bytes: new Uint8Array(0), regions: [] };

  const totalBytes = chunk.sections.reduce((a, s) => a + s.bytes, 0);
  const capped = Math.min(totalBytes, 4096);
  const bytes = new Uint8Array(capped);
  crypto.getRandomValues(bytes);

  const regions = [];
  let offset = 0;
  const scale = capped / totalBytes;
  for (const section of chunk.sections) {
    const size = Math.max(1, Math.round(section.bytes * scale));
    regions.push({
      name: section.name,
      color: section.color,
      start: offset,
      end: Math.min(offset + size, capped),
    });
    offset = Math.min(offset + size, capped);
  }

  return { bytes, regions, totalBytes };
}
