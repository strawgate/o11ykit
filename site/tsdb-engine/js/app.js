// ── App Entry Point ──────────────────────────────────────────────────

import { $, formatBytes, formatNum, formatDuration, autoSelectQueryStep } from './utils.js';
import { FlatStore, ChunkedStore, ColumnStore } from './stores.js';
import { loadWasm, wasmReady } from './wasm.js';
import { ScanEngine } from './query.js';
import { renderChart, setupChartTooltip, CHART_COLORS } from './chart.js';
import { buildStorageExplorer } from './storage-explorer.js';
import { generateValue, REGIONS, INSTANCES, METRICS } from './data-gen.js';

const CHUNK_SIZE = 640;
const NS_PER_MS = 1_000_000n;

// ── UI State ─────────────────────────────────────────────────────────

let currentStore = null;
let currentEngine = new ScanEngine();
let generatedMetrics = [];

// ── Generate Data ────────────────────────────────────────────────────

$('#btnGenerate').addEventListener('click', () => {
  const numSeries = parseInt($('#numSeries').value);
  const numPoints = parseInt($('#numPoints').value);
  const pattern = $('#dataPattern').value;
  const backendType = $('#backend').value;
  const intervalMs = parseInt($('#sampleInterval').value);

  const btn = $('#btnGenerate');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        generateData(numSeries, numPoints, pattern, backendType, intervalMs);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Data';
      }
    }, 50);
  });
});

function _createStore(backendType, chunkSize) {
  if (backendType === 'column') {
    if (!wasmReady) {
      alert('WASM codec not loaded — ColumnStore requires WebAssembly. Try ChunkedStore instead.');
      return null;
    }
    return new ColumnStore(chunkSize);
  } else if (backendType === 'chunked') {
    return new ChunkedStore(chunkSize);
  }
  return new FlatStore();
}

function _ingestMetrics(store, numSeries, numPoints, pattern, stepMs, backendType) {
  const now = BigInt(Date.now()) * NS_PER_MS;
  const intervalNs = BigInt(stepMs) * NS_PER_MS;
  const metricsUsed = new Set();

  const allSeriesData = [];
  for (let si = 0; si < numSeries; si++) {
    const metricName = METRICS[si % METRICS.length];
    const region = REGIONS[Math.floor(si / METRICS.length) % REGIONS.length];
    const instance = INSTANCES[si % INSTANCES.length];
    metricsUsed.add(metricName);

    const labels = new Map([
      ['__name__', metricName],
      ['region', region],
      ['instance', instance],
      ['job', 'demo'],
    ]);

    const id = store.getOrCreateSeries(labels);
    const timestamps = new BigInt64Array(numPoints);
    const values = new Float64Array(numPoints);
    const startT = now - BigInt(numPoints) * intervalNs;
    for (let i = 0; i < numPoints; i++) {
      timestamps[i] = startT + BigInt(i) * intervalNs;
      values[i] = generateValue(pattern, i, si, numPoints);
    }
    allSeriesData.push({ id, timestamps, values });
  }

  if (backendType === 'column') {
    const chunkSize = CHUNK_SIZE;
    for (let offset = 0; offset < numPoints; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, numPoints);
      for (const sd of allSeriesData) {
        store.appendBatch(sd.id, sd.timestamps.subarray(offset, end), sd.values.subarray(offset, end));
      }
    }
  } else {
    for (const sd of allSeriesData) {
      store.appendBatch(sd.id, sd.timestamps, sd.values);
    }
  }

  return { metricsUsed, totalIngested: store.sampleCount };
}

function _displayStats(store, metricsUsed, totalIngested, ingestTime, intervalMs, numPoints) {
  const memBytes = store.memoryBytes();
  const rawBytes = totalIngested * 16;
  const compressionRatio = rawBytes / memBytes;

  $('#statsGrid').style.display = '';
  $('#statTotalPoints').textContent = totalIngested.toLocaleString();
  $('#statSeries').textContent = store.seriesCount.toLocaleString();
  $('#statMemory').textContent = formatBytes(memBytes);
  $('#statCompression').textContent = compressionRatio.toFixed(1) + '×';
  $('#statIngestTime').textContent = ingestTime.toFixed(0) + ' ms';
  $('#statIngestRate').textContent = formatNum(totalIngested / (ingestTime / 1000)) + ' pts/s';

  const metricSelect = $('#queryMetric');
  metricSelect.innerHTML = '';
  for (const m of generatedMetrics) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    metricSelect.appendChild(opt);
  }

  $('#queryControls').style.display = '';

  showCompressionBreakdown(rawBytes, memBytes);
  autoSelectQueryStep(intervalMs, numPoints);
  buildStorageExplorer(store);
  runQuery();
}

function generateData(numSeries, numPoints, pattern, backendType, intervalMs = 10000) {
  const store = _createStore(backendType, CHUNK_SIZE);
  if (!store) return;

  const t0 = performance.now();
  const { metricsUsed, totalIngested } = _ingestMetrics(store, numSeries, numPoints, pattern, intervalMs, backendType);
  const ingestTime = performance.now() - t0;

  currentStore = store;
  generatedMetrics = [...metricsUsed];

  _displayStats(store, metricsUsed, totalIngested, ingestTime, intervalMs, numPoints);
}

// ── Query ────────────────────────────────────────────────────────────

$('#btnQuery').addEventListener('click', runQuery);

function runQuery() {
  if (!currentStore) return;

  const metric = $('#queryMetric').value;
  const agg = $('#queryAgg').value || undefined;
  const groupBy = $('#queryGroupBy').value ? [$('#queryGroupBy').value] : undefined;
  const stepMs = parseInt($('#queryStep').value);
  const step = stepMs > 0 ? BigInt(stepMs) * NS_PER_MS : undefined;

  const ids = currentStore.matchLabel('__name__', metric);
  if (ids.length === 0) return;

  let minT = BigInt('9223372036854775807');
  let maxT = -minT;
  for (const id of ids) {
    const data = currentStore.read(id, -minT, minT);
    if (data.timestamps.length > 0) {
      if (data.timestamps[0] < minT) minT = data.timestamps[0];
      if (data.timestamps[data.timestamps.length - 1] > maxT) maxT = data.timestamps[data.timestamps.length - 1];
    }
  }

  const t0 = performance.now();
  const result = currentEngine.query(currentStore, {
    metric, start: minT, end: maxT, agg, groupBy, step,
  });
  const queryTime = performance.now() - t0;

  $('#queryResults').style.display = '';
  $('#qStatScannedSeries').innerHTML = `Scanned: <strong>${result.scannedSeries}</strong> series`;
  $('#qStatScannedSamples').innerHTML = `Samples: <strong>${result.scannedSamples.toLocaleString()}</strong>`;
  $('#qStatResultSeries').innerHTML = `Result: <strong>${result.series.length}</strong> series`;
  $('#qStatQueryTime').innerHTML = `Time: <strong>${queryTime.toFixed(1)} ms</strong>`;

  const aggLabel = agg ? `${agg}(${metric})` : metric;
  const groupLabel = groupBy ? ` by ${groupBy.join(', ')}` : '';
  const stepLabel = step ? ` [${formatDuration(stepMs)} step]` : '';
  const chartTitle = `${aggLabel}${groupLabel}${stepLabel}`;

  renderChart($('#chartCanvas'), result.series, chartTitle);
  setupChartTooltip();

  const legendEl = $('#chartLegend');
  legendEl.innerHTML = '';
  for (let i = 0; i < result.series.length; i++) {
    const s = result.series[i];
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const labelStr = [...s.labels].filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ') || 'all';
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-swatch" style="background:${color}"></span>${labelStr} (${s.timestamps.length.toLocaleString()} pts)`;
    legendEl.appendChild(item);
  }
}

// ── Compression Breakdown ────────────────────────────────────────────

function showCompressionBreakdown(rawBytes, compressedBytes) {
  const el = $('#compressionBench');
  el.style.display = '';
  const bars = $('#compressionBars');
  const maxVal = rawBytes;

  const rows = [
    { label: 'Raw (16 B/pt)', bytes: rawBytes, cls: 'raw' },
    { label: currentStore instanceof ColumnStore ? 'ALP + shared ts' : 'XOR-Delta', bytes: compressedBytes, cls: 'compressed' },
  ];

  bars.innerHTML = rows.map(r => {
    const pct = Math.max(2, (r.bytes / maxVal) * 100);
    return `
      <div class="comp-bar-row">
        <span class="comp-bar-label">${r.label}</span>
        <div class="comp-bar-track">
          <div class="comp-bar-fill ${r.cls}" style="width:${pct}%">${formatBytes(r.bytes)}</div>
        </div>
        <span class="comp-bar-value">${(rawBytes / r.bytes).toFixed(1)}×</span>
      </div>`;
  }).join('');
}

// ── Event Listeners ──────────────────────────────────────────────────

for (const id of ['queryMetric', 'queryAgg', 'queryGroupBy', 'queryStep']) {
  $(`#${id}`).addEventListener('change', () => { if (currentStore) runQuery(); });
}

let resizeController = null;

function installResizeListener() {
  if (resizeController) resizeController.abort();
  resizeController = new AbortController();
  window.addEventListener('resize', () => {
    if (currentStore && $('#queryResults').style.display !== 'none') runQuery();
  }, { signal: resizeController.signal });
}

installResizeListener();

// ── Initialization ───────────────────────────────────────────────────

loadWasm().then(ok => {
  const statusEl = $('#wasmStatus');
  if (ok) {
    statusEl.style.display = 'inline-block';
    statusEl.className = 'wasm-status wasm-ok';
    statusEl.textContent = '✓ WASM loaded (26 KB)';
  } else {
    statusEl.style.display = 'inline-block';
    statusEl.className = 'wasm-status wasm-err';
    statusEl.textContent = '✗ WASM unavailable';
    const colOpt = document.querySelector('#backend option[value="column"]');
    if (colOpt) { colOpt.disabled = true; colOpt.textContent += ' (WASM required)'; }
  }

  requestAnimationFrame(() => {
    setTimeout(() => {
      generateData(
        parseInt($('#numSeries').value),
        parseInt($('#numPoints').value),
        $('#dataPattern').value,
        $('#backend').value,
        parseInt($('#sampleInterval').value),
      );
    }, 100);
  });
});
