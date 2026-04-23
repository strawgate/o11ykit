// ── Storage Explorer ─────────────────────────────────────────────────

import { renderByteExplorer, renderByteExplorerTs } from "./byte-explorer.js";
import { decodeChunk } from "./codec.js";
import {
  buildAlpByteSegments,
  buildTimestampByteSegments,
  buildXorByteSegments,
  pickRandomChunk,
} from "./storage-explorer-model.js";
import {
  buildChunkEmptyState,
  buildFrozenChunkDetailHTML,
  buildHotChunkDetailHTML,
} from "./storage-explorer-presenter.js";
import { renderSparkline } from "./storage-sparkline.js";
import { $, escapeHtml, formatBytes } from "./utils.js";
import { wasmDecodeTimestamps, wasmDecodeValuesALP } from "./wasm.js";

function _showChunkEmptyState(seriesInfos, store) {
  const panel = $("#chunkDetailPanel");
  const title = $("#chunkDetailTitle");
  if (!panel) return;
  panel.style.display = "";
  if (title) title.style.display = "";
  panel.innerHTML = buildChunkEmptyState();
  panel.querySelector("#chunkPickRandom")?.addEventListener("click", () => {
    const pick = pickRandomChunk(seriesInfos);
    if (!pick) return;
    showChunkDetail(pick.si, pick.chunkIndex, pick.type, store);
  });
}

function renderByteMap(compressed, _sampleCount) {
  const container = $("#byteMap");
  if (!container) return;
  const { totalBytes, segments } = buildXorByteSegments(compressed);

  container.innerHTML = segments
    .map((seg) => {
      const pct = Math.max(1, (seg.bytes / totalBytes) * 100);
      return `<div class="byte-segment ${seg.cls}" style="width:${pct}%" title="${seg.label}: ${formatBytes(seg.bytes)}">${seg.bytes > 20 ? formatBytes(seg.bytes) : ""}</div>`;
    })
    .join("");
}

function renderByteMapALP(compressedValues, _compressedTs, _sharedCount) {
  const container = $("#byteMap");
  if (!container) return;
  const { totalBytes, segments } = buildAlpByteSegments(compressedValues);

  container.innerHTML = segments
    .map((seg) => {
      const pct = Math.max(1, (seg.bytes / totalBytes) * 100);
      return `<div class="byte-segment ${seg.cls}" style="width:${pct}%" title="${seg.label}: ${formatBytes(seg.bytes)}">${seg.bytes > 20 ? formatBytes(seg.bytes) : ""}</div>`;
    })
    .join("");
}

function _renderTsByteMap(tsBlob, _sharedCount) {
  const container = document.getElementById("byteMapTs");
  if (!container || !tsBlob) return;
  const { totalBytes, segments } = buildTimestampByteSegments(tsBlob);
  container.innerHTML = segments
    .map((seg) => {
      const pct = Math.max(1, (seg.bytes / totalBytes) * 100);
      return `<div class="byte-segment ${seg.cls}" style="width:${pct}%" title="${seg.label}: ${formatBytes(seg.bytes)}">${seg.bytes > 20 ? formatBytes(seg.bytes) : ""}</div>`;
    })
    .join("");
}

function _decodeChunkData(chunk, isColumn) {
  if (isColumn) {
    const values = wasmDecodeValuesALP(chunk.compressedValues);
    const timestamps = wasmDecodeTimestamps(chunk.tsChunkCompressed);
    return { timestamps, values };
  }
  return decodeChunk(chunk.compressed);
}

export function showChunkDetail(seriesInfo, chunkIndex, type, store) {
  const panel = $("#chunkDetailPanel");
  const title = $("#chunkDetailTitle");
  panel.style.display = "";
  if (title) title.style.display = "";
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const metricName = escapeHtml(seriesInfo.labels.get("__name__") || "unknown");
  const labelStr = [...seriesInfo.labels]
    .filter(([k]) => k !== "__name__")
    .map(([k, v]) => `${escapeHtml(k)}="${escapeHtml(v)}"`)
    .join(", ");

  if (type === "frozen") {
    const chunk = seriesInfo.info.frozen[chunkIndex];
    const isColumn = !!chunk.compressedValues;
    const decoded = _decodeChunkData(chunk, isColumn);
    const totalFrozen = seriesInfo.info.frozen.length;
    const { html, sparkId } = buildFrozenChunkDetailHTML({
      chunk,
      isColumn,
      labelStr,
      metricName,
      chunkIndex,
      totalFrozen,
    });
    panel.innerHTML = html;

    // Prev/Next navigation
    const prevBtn = panel.querySelector("#chunkPrev");
    const nextBtn = panel.querySelector("#chunkNext");
    if (prevBtn)
      prevBtn.addEventListener("click", () =>
        showChunkDetail(seriesInfo, chunkIndex - 1, "frozen", store)
      );
    if (nextBtn)
      nextBtn.addEventListener("click", () =>
        showChunkDetail(seriesInfo, chunkIndex + 1, "frozen", store)
      );

    if (isColumn) {
      // Values store — ALP blob only (no timestamp concatenation)
      renderByteMapALP(chunk.compressedValues, chunk.tsChunkCompressed, chunk.sharedTsSeries);
      renderByteExplorer(chunk.compressedValues, null, 0, chunk.count, "alp-values");

      // Timestamp store — separate explorer
      _renderTsByteMap(chunk.tsChunkCompressed, chunk.sharedTsSeries);
      renderByteExplorerTs(chunk.tsChunkCompressed, chunk.count);
    } else {
      renderByteMap(chunk.compressed, chunk.count);
      renderByteExplorer(chunk.compressed, null, 0, chunk.count, "xor");
    }

    requestAnimationFrame(() => renderSparkline(sparkId, decoded));
  } else {
    const hot = seriesInfo.info.hot;
    const { html, sparkId } = buildHotChunkDetailHTML({ hot, labelStr, metricName });
    panel.innerHTML = html;

    requestAnimationFrame(() => {
      renderSparkline(sparkId, {
        timestamps: hot.timestamps.slice(0, hot.count),
        values: hot.values.slice(0, hot.count),
      });
    });
  }
}

export function buildStorageExplorer(store) {
  const seriesList = $("#storageSeriesList");
  const detailPanel = $("#chunkDetailPanel");
  const detailTitle = $("#chunkDetailTitle");
  detailPanel.style.display = "";
  if (detailTitle) detailTitle.style.display = "";

  // Build series infos
  const seriesInfos = [];
  for (let id = 0; id < store.seriesCount; id++) {
    const labels = store.labels(id);
    const info = store.getChunkInfo(id);
    const frozenSamples = info.frozen.reduce((s, c) => s + c.count, 0);
    const frozenBytes = info.frozen.reduce((s, c) => s + c.compressedBytes, 0);
    const frozenRaw = info.frozen.reduce((s, c) => s + c.rawBytes, 0);
    seriesInfos.push({ id, labels, info, frozenSamples, frozenBytes, frozenRaw });
  }

  // Group by metric name
  const groups = new Map();
  for (const si of seriesInfos) {
    const metricName = si.labels.get("__name__") || "unknown";
    if (!groups.has(metricName)) groups.set(metricName, []);
    groups.get(metricName).push(si);
  }

  const maxSamples = Math.max(...seriesInfos.map((s) => s.frozenSamples + s.info.hot.count));
  const INITIAL_SHOW = 3;

  seriesList.innerHTML = "";
  _showChunkEmptyState(seriesInfos, store);
  for (const [metricName, members] of groups) {
    const safeMetricName = escapeHtml(metricName);
    const groupEl = document.createElement("div");
    groupEl.className = "metric-group";

    const totalPts = members.reduce((s, m) => s + m.frozenSamples + m.info.hot.count, 0);
    const totalBytes = members.reduce(
      (s, m) => s + m.frozenBytes + (m.info.hot.count > 0 ? m.info.hot.rawBytes : 0),
      0
    );

    groupEl.innerHTML = `
      <div class="metric-group-header">
        <span class="metric-group-name">${safeMetricName}</span>
        <span class="metric-group-stats">${members.length} series · ${totalPts.toLocaleString()} pts · ${formatBytes(totalBytes)}</span>
      </div>`;

    const rowContainer = document.createElement("div");
    rowContainer.className = "metric-group-rows";

    const showCount = Math.min(members.length, INITIAL_SHOW);
    for (let i = 0; i < showCount; i++) {
      rowContainer.appendChild(_buildSeriesRow(members[i], maxSamples, store));
    }

    groupEl.appendChild(rowContainer);

    if (members.length > INITIAL_SHOW) {
      const remaining = members.length - INITIAL_SHOW;
      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "metric-group-expand";
      expandBtn.textContent = `Show ${remaining} more series…`;
      expandBtn.addEventListener("click", () => {
        for (let i = INITIAL_SHOW; i < members.length; i++) {
          rowContainer.appendChild(_buildSeriesRow(members[i], maxSamples, store));
        }
        expandBtn.remove();
      });
      groupEl.appendChild(expandBtn);
    }

    seriesList.appendChild(groupEl);
  }
}

const MAX_VISIBLE_CHUNKS = 50;

function _buildSeriesRow(si, _maxSamples, store) {
  const row = document.createElement("div");
  row.className = "storage-series-row";

  const labelStr = [...si.labels]
    .filter(([k]) => k !== "__name__")
    .map(
      ([k, v]) =>
        `<span class="label-pair"><span class="label-key">${escapeHtml(k)}</span>=<span class="label-val">${escapeHtml(v)}</span></span>`
    )
    .join(" ");

  const totalSamples = si.frozenSamples + si.info.hot.count;
  const totalBytes = si.frozenBytes + (si.info.hot.count > 0 ? si.info.hot.rawBytes : 0);
  const frozenCount = si.info.frozen.length;
  const hotBadge = si.info.hot.count > 0 ? `<span class="chunk-count-badge hot">+1 hot</span>` : "";

  row.innerHTML = `
    <div class="series-header">
      <span class="series-labels">${labelStr}</span>
      <span class="series-summary">
        <span class="chunk-count-badge">${frozenCount} chunks</span>${hotBadge}
        ${totalSamples.toLocaleString()} pts · ${formatBytes(totalBytes)}
      </span>
    </div>
    <div class="chunk-bar-row"></div>`;

  const barRow = row.querySelector(".chunk-bar-row");
  const isCol = si.info._isColumnStore;

  // Cap visible frozen chunks to last MAX_VISIBLE_CHUNKS
  const hiddenCount = Math.max(0, frozenCount - MAX_VISIBLE_CHUNKS);
  const startIdx = hiddenCount;

  if (hiddenCount > 0) {
    const elided = document.createElement("span");
    elided.className = "chunk-elided";
    elided.textContent = `${hiddenCount} earlier …`;
    barRow.appendChild(elided);
  }

  for (let ci = startIdx; ci < frozenCount; ci++) {
    const chunk = si.info.frozen[ci];
    const block = document.createElement("button");
    block.type = "button";
    block.className = isCol ? "chunk-block frozen column-store" : "chunk-block frozen";
    block.title = `Chunk ${ci}: ${chunk.count} pts, ${formatBytes(chunk.compressedBytes)}, ${chunk.ratio.toFixed(1)}× compression`;
    block.addEventListener("click", () => showChunkDetail(si, ci, "frozen", store));
    barRow.appendChild(block);
  }

  if (si.info.hot.count > 0) {
    const block = document.createElement("button");
    block.type = "button";
    block.className = "chunk-block hot";
    block.title = `Hot buffer: ${si.info.hot.count} pts, ${formatBytes(si.info.hot.rawBytes)} (uncompressed)`;
    block.addEventListener("click", () => showChunkDetail(si, -1, "hot", store));
    barRow.appendChild(block);
  }

  return row;
}
