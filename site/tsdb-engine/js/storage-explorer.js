// ── Storage Explorer ─────────────────────────────────────────────────

import { $, formatBytes, formatTimeRange, setupCanvasDPR } from './utils.js';
import { decodeChunk } from './codec.js';
import { wasmDecodeValuesALP, wasmDecodeTimestamps } from './wasm.js';
import { renderByteExplorer } from './byte-explorer.js';
import { ALP_HEADER_SIZE } from './byte-explorer-logic.js';

function renderByteMap(compressed, sampleCount) {
  const container = $('#byteMap');
  if (!container) return;

  const totalBytes = compressed.byteLength;
  const headerBytes = Math.min(16, totalBytes);
  const remainingBytes = totalBytes - headerBytes;
  const tsDeltaBytes = Math.round(remainingBytes * 0.25);
  const valXorBytes = remainingBytes - tsDeltaBytes;

  const segments = [
    { label: 'Header', bytes: headerBytes, cls: 'header' },
    { label: 'Timestamps', bytes: tsDeltaBytes, cls: 'timestamps' },
    { label: 'XOR Values', bytes: valXorBytes, cls: 'values' },
  ];

  container.innerHTML = segments.map(seg => {
    const pct = Math.max(1, (seg.bytes / totalBytes) * 100);
    return `<div class="byte-segment ${seg.cls}" style="width:${pct}%" title="${seg.label}: ${formatBytes(seg.bytes)}">${seg.bytes > 20 ? formatBytes(seg.bytes) : ''}</div>`;
  }).join('');
}

function renderByteMapALP(compressedValues, compressedTs, sharedCount) {
  const container = $('#byteMap');
  if (!container) return;

  const valBytes = compressedValues.byteLength;
  const tsBytes = compressedTs.byteLength;
  const amortizedTs = Math.round(tsBytes / sharedCount);

  const alpBW = valBytes >= 4 ? compressedValues[3] : 0;
  const alpCount = valBytes >= 2 ? (compressedValues[0] << 8) | compressedValues[1] : 0;
  const alpExc = valBytes >= ALP_HEADER_SIZE ? (compressedValues[12] << 8) | compressedValues[13] : 0;
  const headerBytes = Math.min(ALP_HEADER_SIZE, valBytes);
  const bpBytes = Math.ceil(alpCount * alpBW / 8);
  const excBytes = alpExc * 10;

  const totalBytes = headerBytes + bpBytes + excBytes + amortizedTs;
  const segments = [
    { label: 'Header', bytes: headerBytes, cls: 'header' },
    { label: 'Offsets', bytes: bpBytes, cls: 'values' },
  ];
  if (excBytes > 0) segments.push({ label: 'Exceptions', bytes: excBytes, cls: 'exceptions' });
  segments.push({ label: `Timestamps (÷${sharedCount})`, bytes: amortizedTs, cls: 'timestamps' });

  container.innerHTML = segments.map(seg => {
    const pct = Math.max(1, (seg.bytes / totalBytes) * 100);
    return `<div class="byte-segment ${seg.cls}" style="width:${pct}%" title="${seg.label}: ${formatBytes(seg.bytes)}">${seg.bytes > 20 ? formatBytes(seg.bytes) : ''}</div>`;
  }).join('');
}

function renderSparkline(canvasId, decoded) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr || 600;
  const h = canvas.height / dpr || 120;
  const ctx = setupCanvasDPR(canvas, w, h);

  const values = decoded.values;
  const n = values.length;
  if (n === 0) return;

  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    if (values[i] < minV) minV = values[i];
    if (values[i] > maxV) maxV = values[i];
  }
  if (minV === maxV) { minV -= 1; maxV += 1; }
  const vRange = maxV - minV;
  const pad = 8;
  const plotW = w - pad * 2;
  const plotH = h - pad * 2;

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad, 0, h - pad);
  grad.addColorStop(0, 'rgba(59, 130, 246, 0.15)');
  grad.addColorStop(1, 'rgba(59, 130, 246, 0.01)');

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = pad + (i / (n - 1)) * plotW;
    const y = pad + ((maxV - values[i]) / vRange) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  const lastX = pad + plotW;
  ctx.lineTo(lastX, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = pad + (i / (n - 1)) * plotW;
    const y = pad + ((maxV - values[i]) / vRange) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function _decodeChunkData(chunk, isColumn) {
  if (isColumn) {
    const values = wasmDecodeValuesALP(chunk.compressedValues);
    const timestamps = wasmDecodeTimestamps(chunk.tsChunkCompressed);
    return { timestamps, values };
  }
  return decodeChunk(chunk.compressed);
}

function _buildChunkDetailHTML(chunk, decoded, isColumn, labelStr, metricName, chunkIndex) {
  const sparkId = 'sparkline-' + Date.now();
  const codecName = isColumn ? 'ALP' : 'XOR-Delta';

  const columnExtra = isColumn ? `
        <div class="detail-stat">
          <div class="detail-stat-label">Values (ALP)</div>
          <div class="detail-stat-value">${formatBytes(chunk.valuesBytes)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Timestamps (shared)</div>
          <div class="detail-stat-value">${formatBytes(chunk.timestampBytes)} ÷ ${chunk.sharedTsSeries} = ${formatBytes(chunk.amortizedTsBytes)}</div>
        </div>` : '';

  const byteLayoutLegend = isColumn ? `
          <span class="byte-legend-item"><span class="byte-swatch header"></span>ALP header (14 B)</span>
          <span class="byte-legend-item"><span class="byte-swatch values"></span>Bit-packed offsets</span>
          <span class="byte-legend-item"><span class="byte-swatch exceptions"></span>Exceptions</span>
          <span class="byte-legend-item"><span class="byte-swatch timestamps"></span>Shared timestamps</span>
        ` : `
          <span class="byte-legend-item"><span class="byte-swatch header"></span>Header (18 B: count + ts₀ + v₀)</span>
          <span class="byte-legend-item"><span class="byte-swatch timestamps"></span>Interleaved Δ²ts + XOR values</span>
        `;

  const html = `
      <div class="chunk-detail-header">
        <div class="chunk-detail-title">
          <span class="tag-frozen">Frozen</span> Chunk ${chunkIndex} — ${metricName}
          <span class="chunk-detail-labels">{${labelStr}}</span>
          <span class="tag-codec">${codecName}</span>
        </div>
        <button class="chunk-close" onclick="this.closest('.chunk-detail-panel').style.display='none'">✕</button>
      </div>
      <div class="chunk-detail-grid">
        <div class="detail-stat">
          <div class="detail-stat-label">Samples</div>
          <div class="detail-stat-value">${chunk.count.toLocaleString()}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Time range</div>
          <div class="detail-stat-value detail-stat-small">${formatTimeRange(chunk.minT, chunk.maxT)}</div>
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
        ${columnExtra}
      </div>
      <div class="chunk-sparkline-container">
        <h4>Decoded Values</h4>
        <canvas id="${sparkId}" width="600" height="120"></canvas>
      </div>
      <div id="codecInsightOuter"></div>
      <div class="chunk-byte-layout">
        <h4>Byte Layout</h4>
        <div class="byte-map" id="byteMap"></div>
        <div class="byte-legend">
          ${byteLayoutLegend}
        </div>
      </div>
      <div class="byte-explorer" id="byteExplorer"></div>`;

  return { html, sparkId };
}

export function showChunkDetail(seriesInfo, chunkIndex, type, store) {
  const panel = $('#chunkDetailPanel');
  panel.style.display = '';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const metricName = seriesInfo.labels.get('__name__') || 'unknown';
  const labelStr = [...seriesInfo.labels]
    .filter(([k]) => k !== '__name__')
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ');

  if (type === 'frozen') {
    const chunk = seriesInfo.info.frozen[chunkIndex];
    const isColumn = !!chunk.compressedValues;
    const decoded = _decodeChunkData(chunk, isColumn);
    const { html, sparkId } = _buildChunkDetailHTML(chunk, decoded, isColumn, labelStr, metricName, chunkIndex);
    panel.innerHTML = html;

    if (isColumn) {
      renderByteMapALP(chunk.compressedValues, chunk.tsChunkCompressed, chunk.sharedTsSeries);
      renderByteExplorer(chunk.compressedValues, chunk.tsChunkCompressed, chunk.sharedTsSeries, chunk.count, 'alp');
    } else {
      renderByteMap(chunk.compressed, chunk.count);
      renderByteExplorer(chunk.compressed, null, 0, chunk.count, 'xor');
    }

    requestAnimationFrame(() => renderSparkline(sparkId, decoded));
  } else {
    const hot = seriesInfo.info.hot;
    const sparkId = 'sparkline-' + Date.now();
    const minT = hot.count > 0 ? hot.timestamps[0] : 0n;
    const maxT = hot.count > 0 ? hot.timestamps[hot.count - 1] : 0n;

    panel.innerHTML = `
      <div class="chunk-detail-header">
        <div class="chunk-detail-title">
          <span class="tag-hot">Hot Buffer</span> — ${metricName}
          <span class="chunk-detail-labels">{${labelStr}}</span>
        </div>
        <button class="chunk-close" onclick="this.closest('.chunk-detail-panel').style.display='none'">✕</button>
      </div>
      <div class="chunk-detail-grid">
        <div class="detail-stat">
          <div class="detail-stat-label">Samples</div>
          <div class="detail-stat-value">${hot.count.toLocaleString()}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Time range</div>
          <div class="detail-stat-value detail-stat-small">${hot.count > 0 ? formatTimeRange(minT, maxT) : '—'}</div>
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
  const explorer = $('#storageExplorer');
  const overview = $('#storageOverview');
  const seriesList = $('#storageSeriesList');
  const detailPanel = $('#chunkDetailPanel');
  explorer.style.display = '';
  detailPanel.style.display = 'none';

  let totalChunks = 0, totalFrozen = 0, totalHotSamples = 0, totalCompressedBytes = 0, totalRawBytes = 0;
  const seriesInfos = [];

  for (let id = 0; id < store.seriesCount; id++) {
    const labels = store.labels(id);
    const info = store.getChunkInfo(id);
    const frozenSamples = info.frozen.reduce((s, c) => s + c.count, 0);
    const frozenBytes = info.frozen.reduce((s, c) => s + c.compressedBytes, 0);
    const frozenRaw = info.frozen.reduce((s, c) => s + c.rawBytes, 0);
    totalFrozen += info.frozen.length;
    totalChunks += info.frozen.length + (info.hot.count > 0 ? 1 : 0);
    totalHotSamples += info.hot.count;
    totalCompressedBytes += frozenBytes + (info.hot.count > 0 ? info.hot.rawBytes : 0);
    totalRawBytes += frozenRaw + info.hot.rawBytes;

    seriesInfos.push({ id, labels, info, frozenSamples, frozenBytes, frozenRaw });
  }

  const firstInfo = seriesInfos.length > 0 ? seriesInfos[0].info : null;
  const isColumnStore = firstInfo && firstInfo._isColumnStore;
  const columnStatsHtml = isColumnStore ? `
      <div class="explorer-stat column-stat">
        <span class="explorer-stat-value">${firstInfo._groupMembers}</span>
        <span class="explorer-stat-label">Series sharing timestamps</span>
      </div>
      <div class="explorer-stat column-stat">
        <span class="explorer-stat-value">${firstInfo._sharedTsChunks}</span>
        <span class="explorer-stat-label">Shared ts chunks</span>
      </div>
      <div class="explorer-stat column-stat">
        <span class="explorer-stat-value">${formatBytes(firstInfo._sharedTsTotalBytes)}</span>
        <span class="explorer-stat-label">Shared ts storage</span>
      </div>` : '';

  overview.innerHTML = `
    <div class="explorer-stats">
      <div class="explorer-stat">
        <span class="explorer-stat-value">${store.seriesCount}</span>
        <span class="explorer-stat-label">Series</span>
      </div>
      <div class="explorer-stat">
        <span class="explorer-stat-value">${totalChunks}</span>
        <span class="explorer-stat-label">Total chunks</span>
      </div>
      <div class="explorer-stat">
        <span class="explorer-stat-value">${totalFrozen}</span>
        <span class="explorer-stat-label">Frozen (compressed)</span>
      </div>
      <div class="explorer-stat">
        <span class="explorer-stat-value">${formatBytes(totalCompressedBytes)}</span>
        <span class="explorer-stat-label">Total storage</span>
      </div>
      <div class="explorer-stat">
        <span class="explorer-stat-value">${totalRawBytes > 0 ? (totalRawBytes / totalCompressedBytes).toFixed(1) + '×' : '—'}</span>
        <span class="explorer-stat-label">Avg compression</span>
      </div>
      ${columnStatsHtml}
    </div>`;

  seriesList.innerHTML = '';
  for (const si of seriesInfos) {
    const row = document.createElement('div');
    row.className = 'storage-series-row';

    const labelStr = [...si.labels]
      .filter(([k]) => k !== '__name__')
      .map(([k, v]) => `<span class="label-pair"><span class="label-key">${k}</span>=<span class="label-val">${v}</span></span>`)
      .join(' ');
    const metricName = si.labels.get('__name__') || 'unknown';

    const totalSamples = si.frozenSamples + si.info.hot.count;
    const totalBytes = si.frozenBytes + (si.info.hot.count > 0 ? si.info.hot.rawBytes : 0);

    row.innerHTML = `
      <div class="series-header">
        <span class="series-metric">${metricName}</span>
        <span class="series-labels">${labelStr}</span>
        <span class="series-summary">${totalSamples.toLocaleString()} pts · ${formatBytes(totalBytes)} · ${si.info.frozen.length} chunks${si.info.hot.count > 0 ? ' + hot' : ''}</span>
      </div>
      <div class="chunk-bar-container"></div>`;

    const barContainer = row.querySelector('.chunk-bar-container');
    const maxSamples = Math.max(...seriesInfos.map(s => s.frozenSamples + s.info.hot.count));
    const totalChunksInSeries = si.info.frozen.length + (si.info.hot.count > 0 ? 1 : 0);
    const compact = totalChunksInSeries > 40;
    if (compact) barContainer.classList.add('compact-chunks');

    const isCol = si.info._isColumnStore;
    for (let ci = 0; ci < si.info.frozen.length; ci++) {
      const chunk = si.info.frozen[ci];
      const block = document.createElement('div');
      block.className = isCol ? 'chunk-block frozen column-store' : 'chunk-block frozen';
      if (!compact) {
        const widthPct = Math.max(2, (chunk.count / maxSamples) * 100);
        block.style.width = widthPct + '%';
      }
      block.title = `Chunk ${ci}: ${chunk.count} pts, ${formatBytes(chunk.compressedBytes)}, ${chunk.ratio.toFixed(1)}× compression`;
      if (!compact) block.innerHTML = `<span class="chunk-label">${chunk.count}</span>`;
      block.addEventListener('click', () => showChunkDetail(si, ci, 'frozen', store));
      barContainer.appendChild(block);
    }

    if (si.info.hot.count > 0) {
      const block = document.createElement('div');
      block.className = 'chunk-block hot';
      if (!compact) {
        const widthPct = Math.max(2, (si.info.hot.count / maxSamples) * 100);
        block.style.width = widthPct + '%';
      }
      block.title = `Hot buffer: ${si.info.hot.count} pts, ${formatBytes(si.info.hot.rawBytes)} (uncompressed)`;
      if (!compact) block.innerHTML = `<span class="chunk-label">${si.info.hot.count}</span>`;
      block.addEventListener('click', () => showChunkDetail(si, -1, 'hot', store));
      barContainer.appendChild(block);
    }

    if (compact) {
      const summary = document.createElement('div');
      summary.className = 'chunk-summary-bar';
      summary.innerHTML = `<span class="chunk-count-badge">${si.info.frozen.length} frozen</span>` +
        (si.info.hot.count > 0 ? `<span class="chunk-count-badge hot">1 hot (${si.info.hot.count.toLocaleString()} pts)</span>` : '') +
        `<span>Click any block to explore</span>`;
      row.appendChild(summary);
    }

    seriesList.appendChild(row);
  }
}
