import { formatBytes, formatTimeRange } from "./utils.js";

export function buildChunkEmptyState() {
  return `
    <div class="chunk-empty-state">
      <div class="chunk-empty-icon">🧭</div>
      <div class="chunk-empty-title">No chunk selected yet</div>
      <p class="chunk-empty-copy">Click a green or orange chunk above to view details, decoded values, and the byte explorer.</p>
      <button type="button" class="chunk-empty-action" id="chunkPickRandom">Pick a random chunk</button>
    </div>`;
}

export function buildFrozenChunkDetailHTML({
  chunk,
  isColumn,
  labelStr,
  metricName,
  chunkIndex,
  totalFrozen,
}) {
  const sparkId = `sparkline-${Date.now()}`;
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

  return {
    sparkId,
    html: `
      <div class="chunk-detail-header">
        <div class="chunk-detail-topline">
          <div class="chunk-detail-title">
            <span class="tag-frozen">Frozen</span>
            <span class="chunk-detail-metric">${metricName}</span>
          </div>
          <div class="chunk-detail-meta">
            <div class="chunk-nav">
              <button type="button" class="chunk-nav-btn" id="chunkPrev" ${hasPrev ? "" : "disabled"} title="Previous chunk">‹</button>
              <span class="chunk-nav-label">Chunk ${chunkIndex} of ${totalFrozen}</span>
              <button type="button" class="chunk-nav-btn" id="chunkNext" ${hasNext ? "" : "disabled"} title="Next chunk">›</button>
            </div>
            <div class="chunk-time-range">${formatTimeRange(chunk.minT, chunk.maxT)}</div>
            <button type="button" class="chunk-close" onclick="this.closest('.chunk-detail-panel').style.display='none'">✕</button>
          </div>
        </div>
        <div class="chunk-detail-label-row">
          <span class="chunk-detail-labels">${labelStr ? labelStr : "—"}</span>
        </div>
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
      ${tsSection}`,
  };
}

export function buildHotChunkDetailHTML({ hot, labelStr, metricName }) {
  const sparkId = `sparkline-${Date.now()}`;
  const minT = hot.count > 0 ? hot.timestamps[0] : 0n;
  const maxT = hot.count > 0 ? hot.timestamps[hot.count - 1] : 0n;
  return {
    sparkId,
    html: `
      <div class="chunk-detail-header">
        <div class="chunk-detail-topline">
          <div class="chunk-detail-title">
            <span class="tag-hot">Hot Buffer</span>
            <span class="chunk-detail-metric">${metricName}</span>
          </div>
          <div class="chunk-detail-meta">
            <div class="chunk-time-range">${hot.count > 0 ? formatTimeRange(minT, maxT) : "—"}</div>
            <button type="button" class="chunk-close" onclick="this.closest('.chunk-detail-panel').style.display='none'">✕</button>
          </div>
        </div>
        <div class="chunk-detail-label-row">
          <span class="chunk-detail-labels">${labelStr ? labelStr : "—"}</span>
        </div>
      </div>
      <div class="chunk-detail-grid">
        <div class="detail-stat">
          <div class="detail-stat-label">Samples</div>
          <div class="detail-stat-value">${hot.count.toLocaleString()}</div>
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
      </div>`,
  };
}
