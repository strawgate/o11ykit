// ── Storage Explorer ─────────────────────────────────────────────────

import { renderByteExplorer, renderByteExplorerTs } from "./byte-explorer.js";
import { ALP_HEADER_SIZE } from "./byte-explorer-logic.js";
import { decodeChunk } from "./codec.js";
import {
  $,
  escapeHtml,
  formatBytes,
  formatEpochNs,
  formatNum,
  formatTimeRange,
  setupCanvasDPR,
} from "./utils.js";
import { wasmDecodeTimestamps, wasmDecodeValuesALP } from "./wasm.js";

const sparklineState = new WeakMap();

function _buildChunkEmptyState() {
  return `
    <div class="chunk-empty-state">
      <div class="chunk-empty-icon">🧭</div>
      <div class="chunk-empty-title">No chunk selected yet</div>
      <p class="chunk-empty-copy">Click a green or orange chunk above to view details, decoded values, and the byte explorer.</p>
      <button type="button" class="chunk-empty-action" id="chunkPickRandom">Pick a random chunk</button>
    </div>`;
}

function _showChunkEmptyState(seriesInfos, store) {
  const panel = $("#chunkDetailPanel");
  const title = $("#chunkDetailTitle");
  if (!panel) return;
  panel.style.display = "";
  if (title) title.style.display = "";
  panel.innerHTML = _buildChunkEmptyState();
  panel.querySelector("#chunkPickRandom")?.addEventListener("click", () => {
    const picks = [];
    for (const si of seriesInfos) {
      for (let i = 0; i < si.info.frozen.length; i++) picks.push({ si, chunkIndex: i, type: "frozen" });
      if (si.info.hot.count > 0) picks.push({ si, chunkIndex: -1, type: "hot" });
    }
    if (picks.length === 0) return;
    const pick = picks[Math.floor(Math.random() * picks.length)];
    showChunkDetail(pick.si, pick.chunkIndex, pick.type, store);
  });
}

function renderByteMap(compressed, _sampleCount) {
  const container = $("#byteMap");
  if (!container) return;

  const totalBytes = compressed.byteLength;
  const headerBytes = Math.min(16, totalBytes);
  const remainingBytes = totalBytes - headerBytes;
  const tsDeltaBytes = Math.round(remainingBytes * 0.25);
  const valXorBytes = remainingBytes - tsDeltaBytes;

  const segments = [
    { label: "Header", bytes: headerBytes, cls: "header" },
    { label: "Timestamps", bytes: tsDeltaBytes, cls: "timestamps" },
    { label: "XOR Values", bytes: valXorBytes, cls: "values" },
  ];

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

  const valBytes = compressedValues.byteLength;

  const alpBW = valBytes >= 4 ? compressedValues[3] : 0;
  const alpCount = valBytes >= 2 ? (compressedValues[0] << 8) | compressedValues[1] : 0;
  const alpExc =
    valBytes >= ALP_HEADER_SIZE ? (compressedValues[12] << 8) | compressedValues[13] : 0;
  const headerBytes = Math.min(ALP_HEADER_SIZE, valBytes);
  const bpBytes = Math.ceil((alpCount * alpBW) / 8);
  const excBytes = alpExc * 10;

  const totalBytes = headerBytes + bpBytes + excBytes;
  const segments = [
    { label: "Header", bytes: headerBytes, cls: "header" },
    { label: "Offsets", bytes: bpBytes, cls: "values" },
  ];
  if (excBytes > 0) segments.push({ label: "Exceptions", bytes: excBytes, cls: "exceptions" });

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
  const tsLen = tsBlob.byteLength;
  const hdrBytes = Math.min(10, tsLen);
  const bodyBytes = tsLen - hdrBytes;
  const segments = [
    { label: "Header", bytes: hdrBytes, cls: "timestamps" },
    { label: "Δ² Body", bytes: bodyBytes, cls: "timestamps" },
  ];
  container.innerHTML = segments
    .map((seg) => {
      const pct = Math.max(1, (seg.bytes / tsLen) * 100);
      return `<div class="byte-segment ${seg.cls}" style="width:${pct}%" title="${seg.label}: ${formatBytes(seg.bytes)}">${seg.bytes > 20 ? formatBytes(seg.bytes) : ""}</div>`;
    })
    .join("");
}

function renderSparkline(canvasId, decoded) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const values = decoded.values;
  const n = values.length;
  if (n === 0) return;
  const timestamps = decoded.timestamps || [];

  let state = sparklineState.get(canvas);
  if (!state) {
    state = {
      hoverIndex: null,
      redraw: null,
      bound: false,
    };
    sparklineState.set(canvas, state);
  }

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const pickDimensions = () => {
    const rect = canvas.getBoundingClientRect();
    const attrW = Number(canvas.getAttribute("width")) || 600;
    const attrH = Number(canvas.getAttribute("height")) || 140;
    return {
      w: Math.max(260, Math.round(rect.width || canvas.clientWidth || attrW)),
      h: Math.max(120, Math.round(rect.height || canvas.clientHeight || attrH)),
    };
  };

  const draw = () => {
    const { w, h } = pickDimensions();
    const ctx = setupCanvasDPR(canvas, w, h);
    ctx.clearRect(0, 0, w, h);

    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      if (values[i] < minV) minV = values[i];
      if (values[i] > maxV) maxV = values[i];
    }
    if (minV === maxV) {
      minV -= 1;
      maxV += 1;
    }
    const valuePadding = (maxV - minV) * 0.08 || 1;
    minV -= valuePadding;
    maxV += valuePadding;
    const vRange = maxV - minV;

    const left = 14;
    const right = 12;
    const top = 12;
    const bottom = 18;
    const plotLeft = left;
    const plotTop = top;
    const plotRight = w - right;
    const plotBottom = h - bottom;
    const plotW = Math.max(1, plotRight - plotLeft);
    const plotH = Math.max(1, plotBottom - plotTop);

    const xAt = (index) => {
      if (n <= 1) return plotLeft + plotW / 2;
      return plotLeft + (index / (n - 1)) * plotW;
    };
    const yAt = (value) =>
      clamp(plotTop + ((maxV - value) / vRange) * plotH, plotTop, plotBottom);

    ctx.fillStyle = "rgba(247, 251, 255, 0.96)";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(15, 58, 94, 0.08)";
    ctx.lineWidth = 1;
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const y = plotTop + (i / yTicks) * plotH;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
    }
    const xTicks = Math.min(6, Math.max(2, n - 1));
    for (let i = 0; i <= xTicks; i++) {
      const x = plotLeft + (i / xTicks) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(15, 58, 94, 0.18)";
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotTop);
    ctx.lineTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.stroke();

    const grad = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
    grad.addColorStop(0, "rgba(59, 130, 246, 0.18)");
    grad.addColorStop(1, "rgba(59, 130, 246, 0.02)");

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = clamp(xAt(i), plotLeft, plotRight);
      const y = yAt(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(clamp(xAt(n - 1), plotLeft, plotRight), plotBottom);
    ctx.lineTo(clamp(xAt(0), plotLeft, plotRight), plotBottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = clamp(xAt(i), plotLeft, plotRight);
      const y = yAt(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.75;
    ctx.stroke();

    if (state.hoverIndex !== null && state.hoverIndex >= 0 && state.hoverIndex < n) {
      const idx = state.hoverIndex;
      const x = clamp(xAt(idx), plotLeft, plotRight);
      const y = yAt(values[idx]);

      ctx.strokeStyle = "rgba(15, 58, 94, 0.24)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#2563eb";
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.stroke();

      const tooltipLines = [`Value: ${formatNum(values[idx])}`];
      if (timestamps[idx] !== undefined) tooltipLines.push(formatEpochNs(timestamps[idx]));

      ctx.font = '12px "IBM Plex Mono", monospace';
      const tooltipW =
        Math.max(...tooltipLines.map((line) => ctx.measureText(line).width)) + 18;
      const tooltipH = tooltipLines.length * 16 + 12;
      const tooltipX = clamp(x + 10, plotLeft + 6, plotRight - tooltipW - 4);
      const tooltipY = y < plotTop + 34 ? y + 10 : y - tooltipH - 10;

      ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
      ctx.beginPath();
      ctx.roundRect(tooltipX, tooltipY, tooltipW, tooltipH, 8);
      ctx.fill();

      ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
      tooltipLines.forEach((line, lineIndex) => {
        ctx.fillText(line, tooltipX + 9, tooltipY + 18 + lineIndex * 16);
      });
    }
  };

  state.redraw = draw;
  draw();

  if (!state.bound) {
    state.bound = true;
    canvas.addEventListener("mousemove", (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const usableWidth = Math.max(1, rect.width - 26);
      const relative = clamp((x - 14) / usableWidth, 0, 1);
      state.hoverIndex = Math.round(relative * (n - 1));
      state.redraw?.();
    });
    canvas.addEventListener("mouseleave", () => {
      state.hoverIndex = null;
      state.redraw?.();
    });
  }
}

function _decodeChunkData(chunk, isColumn) {
  if (isColumn) {
    const values = wasmDecodeValuesALP(chunk.compressedValues);
    const timestamps = wasmDecodeTimestamps(chunk.tsChunkCompressed);
    return { timestamps, values };
  }
  return decodeChunk(chunk.compressed);
}

function _buildChunkDetailHTML(
  chunk,
  _decoded,
  isColumn,
  labelStr,
  metricName,
  chunkIndex,
  totalFrozen
) {
  const sparkId = `sparkline-${Date.now()}`;
  const codecName = isColumn ? "ALP" : "XOR-Delta";
  const hasPrev = chunkIndex > 0;
  const hasNext = chunkIndex < totalFrozen - 1;

  const byteLayoutLegend = isColumn
    ? `
          <span class="byte-legend-item"><span class="byte-swatch header"></span>ALP header (14 B)</span>
          <span class="byte-legend-item"><span class="byte-swatch values"></span>Bit-packed offsets</span>
          <span class="byte-legend-item"><span class="byte-swatch exceptions"></span>Exceptions</span>
        `
    : `
          <span class="byte-legend-item"><span class="byte-swatch header"></span>Header (18 B: count + ts₀ + v₀)</span>
          <span class="byte-legend-item"><span class="byte-swatch timestamps"></span>Interleaved Δ²ts + XOR values</span>
        `;

  const tsSection = isColumn
    ? `
      <div class="chunk-ts-section">
        <h4>Timestamps <span class="store-badge ts">Gorilla Δ² · shared ÷ ${chunk.sharedTsSeries}</span></h4>
        <div class="byte-map" id="byteMapTs"></div>
        <div class="byte-legend">
          <span class="byte-legend-item"><span class="byte-swatch timestamps"></span>Timestamp header (10 B)</span>
          <span class="byte-legend-item"><span class="byte-swatch timestamps"></span>Δ² body</span>
        </div>
        <div class="byte-explorer" id="byteExplorerTs"></div>
      </div>`
    : "";

  // Memory breakdown for ColumnStore
  const memStats = isColumn
    ? `
        <div class="detail-stat">
          <div class="detail-stat-label">Values</div>
          <div class="detail-stat-value">${formatBytes(chunk.valuesBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Timestamps</div>
          <div class="detail-stat-value">${formatBytes(chunk.timestampBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">TS amortized</div>
          <div class="detail-stat-value">${formatBytes(chunk.amortizedTsBytes)} (÷${chunk.sharedTsSeries})</div>
        </div>`
    : "";

  const html = `
      <div class="chunk-detail-header">
        <div class="chunk-nav">
          <button type="button" class="chunk-nav-btn" id="chunkPrev" ${hasPrev ? "" : "disabled"} title="Previous chunk">‹</button>
          <span class="chunk-nav-label">Chunk ${chunkIndex} of ${totalFrozen}</span>
          <button type="button" class="chunk-nav-btn" id="chunkNext" ${hasNext ? "" : "disabled"} title="Next chunk">›</button>
        </div>
        <div class="chunk-detail-title">
          <span class="tag-frozen">Frozen</span> ${metricName}
          <span class="chunk-detail-labels">{${labelStr}}</span>
          <span class="tag-codec">${codecName}</span>
        </div>
        <div class="chunk-time-range">${formatTimeRange(chunk.minT, chunk.maxT)}</div>
        <button type="button" class="chunk-close" onclick="this.closest('.chunk-detail-panel').style.display='none'">✕</button>
      </div>
      <div class="chunk-detail-body">
        <div class="chunk-detail-sparkline">
          <h4>Decoded Values</h4>
          <canvas id="${sparkId}" width="600" height="150"></canvas>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Samples</div>
          <div class="detail-stat-value">${chunk.count.toLocaleString()}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Raw size</div>
          <div class="detail-stat-value">${formatBytes(chunk.rawBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Compressed</div>
          <div class="detail-stat-value">${formatBytes(chunk.compressedBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Ratio</div>
          <div class="detail-stat-value ratio-highlight">${chunk.ratio.toFixed(1)}×</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Bits/sample</div>
          <div class="detail-stat-value">${((chunk.compressedBytes * 8) / chunk.count).toFixed(1)}</div>
        </div>
        ${memStats}
      </div>
      <div class="chunk-byte-layout">
        <h4>${isColumn ? "Values" : "Byte Layout"} <span class="store-badge val">${isColumn ? `ALP · ${formatBytes(chunk.valuesBytes)}` : ""}</span></h4>
        <div class="byte-map" id="byteMap"></div>
        <div class="byte-legend">
          ${byteLayoutLegend}
        </div>
      </div>
      <div class="byte-explorer" id="byteExplorer"></div>
      ${tsSection}`;

  return { html, sparkId };
}

export function showChunkDetail(seriesInfo, chunkIndex, type, store) {
  const panel = $("#chunkDetailPanel");
  const title = $("#chunkDetailTitle");
  panel.style.display = "";
  if (title) title.style.display = "";
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const metricName = seriesInfo.labels.get("__name__") || "unknown";
  const labelStr = [...seriesInfo.labels]
    .filter(([k]) => k !== "__name__")
    .map(([k, v]) => `${escapeHtml(k)}="${escapeHtml(v)}"`)
    .join(", ");

  if (type === "frozen") {
    const chunk = seriesInfo.info.frozen[chunkIndex];
    const isColumn = !!chunk.compressedValues;
    const decoded = _decodeChunkData(chunk, isColumn);
    const totalFrozen = seriesInfo.info.frozen.length;
    const { html, sparkId } = _buildChunkDetailHTML(
      chunk,
      decoded,
      isColumn,
      labelStr,
      metricName,
      chunkIndex,
      totalFrozen
    );
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
    const sparkId = `sparkline-${Date.now()}`;
    const minT = hot.count > 0 ? hot.timestamps[0] : 0n;
    const maxT = hot.count > 0 ? hot.timestamps[hot.count - 1] : 0n;

    panel.innerHTML = `
      <div class="chunk-detail-header">
        <div class="chunk-detail-title">
          <span class="tag-hot">Hot Buffer</span> — ${metricName}
          <span class="chunk-detail-labels">{${labelStr}}</span>
        </div>
        <button type="button" class="chunk-close" onclick="this.closest('.chunk-detail-panel').style.display='none'">✕</button>
      </div>
      <div class="chunk-detail-grid">
        <div class="detail-stat">
          <div class="detail-stat-label">Samples</div>
          <div class="detail-stat-value">${hot.count.toLocaleString()}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Time range</div>
          <div class="detail-stat-value detail-stat-small">${hot.count > 0 ? formatTimeRange(minT, maxT) : "—"}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Raw size</div>
          <div class="detail-stat-value">${formatBytes(hot.rawBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Allocated</div>
          <div class="detail-stat-value">${formatBytes(hot.allocatedBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Compression</div>
          <div class="detail-stat-value">None (raw)</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Status</div>
          <div class="detail-stat-value">🔥 Active write</div>
        </div>
      </div>
      <div class="chunk-sparkline-container">
        <h4>Raw Values</h4>
        <canvas id="${sparkId}" width="600" height="120"></canvas>
      </div>`;

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
    const groupEl = document.createElement("div");
    groupEl.className = "metric-group";

    const totalPts = members.reduce((s, m) => s + m.frozenSamples + m.info.hot.count, 0);
    const totalBytes = members.reduce(
      (s, m) => s + m.frozenBytes + (m.info.hot.count > 0 ? m.info.hot.rawBytes : 0),
      0
    );

    groupEl.innerHTML = `
      <div class="metric-group-header">
        <span class="metric-group-name">${metricName}</span>
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

function _buildSeriesRow(si, maxSamples, store) {
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
