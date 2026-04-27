// @ts-nocheck
// ── Storage Explorer — UI controller ────────────────────────────────

import { renderByteExplorer } from "./byte-explorer.js";
import { buildByteExplorerData, buildStorageModel } from "./storage-model.js";
import { $, $$, el, formatBytes, formatNum, formatPercent, serviceColorVar } from "./utils.js";

let storageModel = null;
let serviceNames = [];

/**
 * Build the storage explorer UI for the given span data.
 */
export function buildStorageExplorer(spans, svcNames) {
  serviceNames = svcNames;
  storageModel = buildStorageModel(spans, svcNames);

  renderStorageStats(storageModel.stats);
  renderSeriesList(storageModel.streams);
  renderEmptyChunkDetail();
}

/**
 * Refresh storage stats (e.g. after data update).
 */
export function refreshStorageStats(spans, svcNames) {
  serviceNames = svcNames;
  storageModel = buildStorageModel(spans, svcNames);
  renderStorageStats(storageModel.stats);
}

function renderStorageStats(stats) {
  const container = $("#storageStatsRow");
  if (!container) return;

  container.innerHTML = "";
  const items = [
    { label: "Spans", value: formatNum(stats.totalSpans) },
    { label: "Chunks", value: `${stats.frozenChunks} ❄️ ${stats.hotChunks} 🔥` },
    { label: "Raw Size", value: formatBytes(stats.rawBytes) },
    { label: "Encoded", value: formatBytes(stats.encodedBytes) },
    { label: "Compression", value: `${stats.compressionRatio.toFixed(1)}×` },
    { label: "Bytes/Span", value: String(stats.bytesPerSpan) },
    { label: "Bloom FPR", value: formatPercent(stats.bloomFPR * 100) },
  ];

  for (const item of items) {
    container.appendChild(
      el(
        "div",
        { className: "stat-card" },
        el("div", { className: "stat-big compact" }, item.value),
        el("div", { className: "stat-desc" }, item.label)
      )
    );
  }
}

function renderSeriesList(streams) {
  const container = $("#storageSeriesList");
  if (!container) return;
  container.innerHTML = "";

  const byService = new Map();
  for (const stream of streams) {
    if (!byService.has(stream.service)) byService.set(stream.service, []);
    byService.get(stream.service).push(stream);
  }

  for (const [service, serviceStreams] of byService) {
    const group = el("div", { className: "service-group" });

    const totalSpans = serviceStreams.reduce((a, s) => a + s.spans.length, 0);
    const header = el(
      "div",
      { className: "service-group-header" },
      el("span", {
        className: "service-group-swatch",
        style: { background: serviceColorVar(service, serviceNames) },
      }),
      el("span", { className: "service-group-name" }, service),
      el("span", { className: "service-group-count" }, `${formatNum(totalSpans)} spans`)
    );

    let expanded = true;
    const rowsContainer = el("div", {});

    header.addEventListener("click", () => {
      expanded = !expanded;
      rowsContainer.style.display = expanded ? "" : "none";
    });

    group.appendChild(header);

    for (const stream of serviceStreams) {
      const row = el("div", { className: "storage-series-row" });

      const nameEl = el("span", { className: "series-span-name" }, stream.operation);

      const chunkBar = el("div", { className: "chunk-bar-row" });
      for (const chunk of stream.chunks) {
        const block = el("span", { className: `chunk-block ${chunk.frozen ? "frozen" : "hot"}` });
        block.title = `Chunk ${chunk.index}: ${chunk.size} spans (${chunk.frozen ? "frozen" : "hot"})`;
        block.addEventListener("click", (e) => {
          e.stopPropagation();
          showChunkDetail(stream, chunk);
        });
        chunkBar.appendChild(block);
      }

      row.appendChild(nameEl);
      row.appendChild(chunkBar);

      row.addEventListener("click", () => {
        $$(".storage-series-row").forEach((r) => {
          r.classList.remove("active");
        });
        row.classList.add("active");
        if (stream.chunks.length > 0) {
          showChunkDetail(stream, stream.chunks[0]);
        }
      });

      rowsContainer.appendChild(row);
    }

    group.appendChild(rowsContainer);
    container.appendChild(group);
  }
}

function renderEmptyChunkDetail() {
  const panel = $("#chunkDetailPanel");
  if (!panel) return;
  panel.innerHTML = "";
  panel.appendChild(
    el("div", { className: "chunk-empty-state" }, "← Select a stream or chunk to inspect")
  );
}

function showChunkDetail(stream, chunk) {
  const panel = $("#chunkDetailPanel");
  if (!panel) return;
  panel.innerHTML = "";

  // Header
  const header = el(
    "div",
    { className: "chunk-detail-header" },
    el("h4", {}, `${stream.service} / ${stream.operation}`),
    el(
      "span",
      {
        className: `chunk-detail-badge ${chunk.frozen ? "frozen" : "hot"}`,
      },
      chunk.frozen ? "❄️ Frozen" : "🔥 Hot"
    ),
    el(
      "span",
      {
        className: "chunk-detail-badge",
        style: { background: "var(--dark-bg)", color: "var(--dark-text)" },
      },
      `${chunk.size} spans · Chunk #${chunk.index}`
    )
  );
  panel.appendChild(header);

  // Section breakdown
  const sections = el("div", { className: "chunk-sections" });
  const _totalSectionBytes = chunk.sections.reduce((a, s) => a + s.bytes, 0);
  for (const section of chunk.sections) {
    sections.appendChild(
      el(
        "div",
        { className: "chunk-section" },
        el("span", { className: "chunk-section-swatch", style: { background: section.color } }),
        el("span", { className: "chunk-section-name" }, section.name),
        el("span", { className: "chunk-section-size" }, formatBytes(section.bytes))
      )
    );
  }
  panel.appendChild(sections);

  // Bloom filter visualization
  if (chunk.bloom) {
    const bloomViz = el("div", { className: "bloom-viz" });
    bloomViz.appendChild(el("div", { className: "bloom-viz-header" }, "Bloom Filter"));

    const stats = el("div", { className: "bloom-viz-stats" });
    stats.innerHTML = `
      <span class="label">Bits:</span> <span>${chunk.bloom.numBits}</span>
      <span class="label">Set:</span> <span>${chunk.bloom.setBitCount}</span>
      <span class="label">Fill:</span> <span>${((chunk.bloom.setBitCount / chunk.bloom.numBits) * 100).toFixed(1)}%</span>
    `;
    bloomViz.appendChild(stats);

    const bitGrid = el("div", { className: "bloom-bit-grid" });
    const displayBits = Math.min(chunk.bloom.numBits, 512);
    for (let i = 0; i < displayBits; i++) {
      const byteIdx = i >> 3;
      const bitIdx = i & 7;
      const isSet =
        byteIdx < chunk.bloom.bits.length && (chunk.bloom.bits[byteIdx] & (1 << bitIdx)) !== 0;
      bitGrid.appendChild(el("span", { className: `bloom-bit${isSet ? " set" : ""}` }));
    }
    bloomViz.appendChild(bitGrid);
    panel.appendChild(bloomViz);
  }

  // Byte explorer
  const byteData = buildByteExplorerData(chunk);
  if (byteData.bytes.length > 0) {
    const explorerContainer = el("div", {
      className: "byte-explorer",
      id: "byteExplorerContainer",
    });
    panel.appendChild(explorerContainer);
    renderByteExplorer(explorerContainer, byteData);
  }
}
