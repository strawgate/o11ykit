// ── App Entry Point ──────────────────────────────────────────────────

import { CHART_COLORS, renderChart, setupChartTooltip } from "./chart.js";
import { generateScenarioData, generateValue, INSTANCES, METRICS, REGIONS, SCENARIOS } from "./data-gen.js";
import { ScanEngine } from "./query.js";
import { buildLayoutDiagram, buildStorageExplorer, showChunkDetail } from "./storage-explorer.js";
import { ChunkedStore, ColumnStore, FlatStore } from "./stores.js";
import { $, autoSelectQueryStep, formatBytes, formatDuration, formatNum } from "./utils.js";
import { loadWasm, wasmReady } from "./wasm.js";

const CHUNK_SIZE = 640;
const NS_PER_MS = 1_000_000n;

// ── State ─────────────────────────────────────────────────────────────

let currentStore = null;
const currentEngine = new ScanEngine();
let generatedMetrics = [];
let activeMatchers = []; // [{label, op, value}]
let availableLabels = new Map(); // label -> Set of values

// ── Section visibility ────────────────────────────────────────────────

function showSection(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

function onDataLoaded(store, metrics, ingestTime, numPoints, intervalMs) {
  currentStore = store;
  generatedMetrics = metrics;

  // Populate available labels for matcher UI
  _buildAvailableLabels(store);

  // Show storage section
  showSection('section-storage');
  const layoutContainer = document.getElementById('storageLayoutDiagram');
  if (layoutContainer) buildLayoutDiagram(store, layoutContainer);
  buildStorageExplorer(store);

  // Update ingest stats
  const totalPts = store.sampleCount;
  const memBytes = store.memoryBytes();
  const rawBytes = totalPts * 16;
  const ratio = rawBytes / memBytes;

  document.getElementById('statStoragePts').textContent = totalPts.toLocaleString();
  document.getElementById('statStorageSeries').textContent = store.seriesCount.toLocaleString();
  document.getElementById('statStorageMem').textContent = formatBytes(memBytes);
  document.getElementById('statStorageRatio').textContent = `${ratio.toFixed(1)}×`;
  document.getElementById('statStorageIngestTime').textContent = `${ingestTime.toFixed(0)} ms`;
  document.getElementById('statStorageIngestRate').textContent = `${formatNum(totalPts / (ingestTime / 1000))} pts/s`;

  // Show query lab
  showSection('section-query');
  _populateQueryMetrics(metrics);
  _populateGroupByOptions(store);

  // Run default query immediately
  runQuery();
}

function _buildAvailableLabels(store) {
  availableLabels.clear();
  for (let id = 0; id < store.seriesCount; id++) {
    const labels = store.labels(id);
    if (!labels) continue;
    for (const [k, v] of labels) {
      if (k === '__name__') continue;
      if (!availableLabels.has(k)) availableLabels.set(k, new Set());
      availableLabels.get(k).add(v);
    }
  }
  _refreshMatcherLabelSelect();
  _refreshGroupByOptions();
}

function _populateQueryMetrics(metrics) {
  const sel = document.getElementById('queryMetric');
  if (!sel) return;
  sel.innerHTML = '';
  for (const m of metrics) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
}

function _populateGroupByOptions(store) {
  const sel = document.getElementById('queryGroupBy');
  if (!sel) return;
  const existing = [...availableLabels.keys()];
  sel.innerHTML = '<option value="">No grouping</option>';
  for (const k of existing) {
    if (k === '__name__') continue;
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  }
}

function _refreshGroupByOptions() {
  _populateGroupByOptions(currentStore);
}

// ── Matcher UI ────────────────────────────────────────────────────────

function _refreshMatcherLabelSelect() {
  const sel = document.getElementById('matcherLabel');
  if (!sel) return;
  sel.innerHTML = '<option value="">label…</option>';
  for (const k of availableLabels.keys()) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  }
}

document.getElementById('matcherLabel')?.addEventListener('change', () => {
  const label = document.getElementById('matcherLabel').value;
  const valSel = document.getElementById('matcherValue');
  if (!valSel) return;
  valSel.innerHTML = '<option value="">value…</option>';
  const vals = availableLabels.get(label) || new Set();
  for (const v of vals) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    valSel.appendChild(opt);
  }
});

document.getElementById('btnAddMatcher')?.addEventListener('click', () => {
  const label = document.getElementById('matcherLabel')?.value;
  const op = document.getElementById('matcherOp')?.value || '=';
  const value = document.getElementById('matcherValue')?.value;
  if (!label || !value) return;

  activeMatchers.push({ label, op, value });
  _renderMatcherChips();
  if (currentStore) runQuery();
});

function _renderMatcherChips() {
  const chips = document.getElementById('matcherChips');
  if (!chips) return;
  chips.innerHTML = activeMatchers.map((m, i) =>
    `<span class="matcher-chip">
      <span class="mc-label">${m.label}</span>
      <span class="mc-op">${m.op}</span>
      <span class="mc-val">&quot;${m.value}&quot;</span>
      <button type="button" class="mc-remove" data-idx="${i}" aria-label="Remove matcher">×</button>
    </span>`
  ).join('');
  chips.querySelectorAll('.mc-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      activeMatchers.splice(parseInt(btn.dataset.idx, 10), 1);
      _renderMatcherChips();
      if (currentStore) runQuery();
    });
  });
}

// ── Storage backend tabs ──────────────────────────────────────────────

document.getElementById('section-storage')?.querySelectorAll('.backend-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const newBackend = tab.dataset.backend;
    if (!currentStore || currentStore._backendType === newBackend) return;

    document.querySelectorAll('.backend-tab').forEach(t => t.classList.toggle('active', t === tab));
    _rebuildStoreWithBackend(newBackend);
  });
});

function _rebuildStoreWithBackend(backendType) {
  if (!currentStore || !_lastIngestData) return;
  const newStore = _createStore(backendType, CHUNK_SIZE);
  if (!newStore) return;

  for (const sd of _lastIngestData) {
    const id = newStore.getOrCreateSeries(sd.labels);
    if (backendType === 'column') {
      const n = sd.timestamps.length;
      for (let offset = 0; offset < n; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, n);
        newStore.appendBatch(id, sd.timestamps.subarray(offset, end), sd.values.subarray(offset, end));
      }
    } else {
      newStore.appendBatch(id, sd.timestamps, sd.values);
    }
  }

  currentStore = newStore;

  const layoutContainer = document.getElementById('storageLayoutDiagram');
  if (layoutContainer) buildLayoutDiagram(newStore, layoutContainer);
  buildStorageExplorer(newStore);

  const memBytes = newStore.memoryBytes();
  const rawBytes = newStore.sampleCount * 16;
  document.getElementById('statStorageMem').textContent = formatBytes(memBytes);
  document.getElementById('statStorageRatio').textContent = `${(rawBytes / memBytes).toFixed(1)}×`;

  runQuery();
}

// ── Scenario picker ───────────────────────────────────────────────────

function _renderScenarioCards() {
  const grid = document.getElementById('scenarioGrid');
  if (!grid) return;
  grid.innerHTML = SCENARIOS.map(s => `
    <button type="button" class="scenario-card" data-scenario-id="${s.id}">
      <div class="sc-emoji">${s.emoji}</div>
      <div class="sc-name">${s.name}</div>
      <div class="sc-desc">${s.description}</div>
      <div class="sc-meta">
        ${s.metrics.map(m => `<span class="sc-metric">${m.name}</span>`).join('')}
      </div>
      <div class="sc-stats">${s.metrics.length * s.labelGroups.length} series · ${(s.numPoints).toLocaleString()} pts · ${s.intervalMs >= 60000 ? `${s.intervalMs/60000}min` : `${s.intervalMs/1000}s`} interval</div>
    </button>
  `).join('');

  grid.querySelectorAll('.scenario-card').forEach(card => {
    card.addEventListener('click', () => {
      const scenario = SCENARIOS.find(s => s.id === card.dataset.scenarioId);
      if (scenario) loadScenario(scenario, card);
    });
  });
}

let _lastIngestData = null;

function loadScenario(scenario, clickedCard) {
  document.querySelectorAll('.scenario-card').forEach(c => c.classList.remove('active'));
  if (clickedCard) clickedCard.classList.add('active');

  const backendType = document.getElementById('scenarioBackend')?.value || 'column';
  const store = _createStore(backendType, CHUNK_SIZE);
  if (!store) return;

  const t0 = performance.now();
  const seriesData = generateScenarioData(scenario);
  _lastIngestData = seriesData;

  for (const sd of seriesData) {
    const id = store.getOrCreateSeries(sd.labels);
    if (backendType === 'column') {
      const n = sd.timestamps.length;
      for (let offset = 0; offset < n; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, n);
        store.appendBatch(id, sd.timestamps.subarray(offset, end), sd.values.subarray(offset, end));
      }
    } else {
      store.appendBatch(id, sd.timestamps, sd.values);
    }
  }

  const ingestTime = performance.now() - t0;
  const metrics = [...new Set(scenario.metrics.map(m => m.name))];

  onDataLoaded(store, metrics, ingestTime, scenario.numPoints, scenario.intervalMs);
  autoSelectQueryStep(scenario.intervalMs, scenario.numPoints);
}

// ── Custom generator ──────────────────────────────────────────────────

document.getElementById('btnCustomGenerate')?.addEventListener('click', () => {
  const numSeries = parseInt(document.getElementById('numSeries').value, 10);
  const numPoints = parseInt(document.getElementById('numPoints').value, 10);
  const pattern = document.getElementById('dataPattern').value;
  const backendType = document.getElementById('customBackend').value;
  const intervalMs = parseInt(document.getElementById('sampleInterval').value, 10);

  const btn = document.getElementById('btnCustomGenerate');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        generateCustomData(numSeries, numPoints, pattern, backendType, intervalMs);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Data';
      }
    }, 50);
  });
});

function _createStore(backendType, chunkSize) {
  let store;
  if (backendType === 'column') {
    if (!wasmReady) {
      const statusEl = document.getElementById('wasmStatusCustom');
      if (statusEl) {
        statusEl.style.display = 'inline-block';
        statusEl.textContent = '⚠ WASM unavailable — switch to ChunkedStore';
      }
      return null;
    }
    store = new ColumnStore(chunkSize);
  } else if (backendType === 'chunked') {
    store = new ChunkedStore(chunkSize);
  } else {
    store = new FlatStore();
  }
  store._backendType = backendType;
  return store;
}

function generateCustomData(numSeries, numPoints, pattern, backendType, intervalMs) {
  const store = _createStore(backendType, CHUNK_SIZE);
  if (!store) return;

  const now = BigInt(Date.now()) * NS_PER_MS;
  const intervalNs = BigInt(intervalMs) * NS_PER_MS;
  const metricsUsed = new Set();
  const seriesData = [];

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

    const timestamps = new BigInt64Array(numPoints);
    const values = new Float64Array(numPoints);
    const startT = now - BigInt(numPoints) * intervalNs;
    for (let i = 0; i < numPoints; i++) {
      timestamps[i] = startT + BigInt(i) * intervalNs;
      values[i] = generateValue(pattern, i, si, numPoints);
    }
    seriesData.push({ labels, timestamps, values });
  }

  _lastIngestData = seriesData;

  const t0 = performance.now();
  for (const sd of seriesData) {
    const id = store.getOrCreateSeries(sd.labels);
    if (backendType === 'column') {
      for (let offset = 0; offset < numPoints; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, numPoints);
        store.appendBatch(id, sd.timestamps.subarray(offset, end), sd.values.subarray(offset, end));
      }
    } else {
      store.appendBatch(id, sd.timestamps, sd.values);
    }
  }
  const ingestTime = performance.now() - t0;

  document.querySelectorAll('.scenario-card').forEach(c => c.classList.remove('active'));
  onDataLoaded(store, [...metricsUsed], ingestTime, numPoints, intervalMs);
  autoSelectQueryStep(intervalMs, numPoints);
}

// ── Query Lab ─────────────────────────────────────────────────────────

document.getElementById('btnQuery')?.addEventListener('click', runQuery);

for (const id of ['queryMetric', 'queryAgg', 'queryGroupBy', 'queryStep', 'queryTransform']) {
  document.getElementById(id)?.addEventListener('change', () => {
    if (currentStore) runQuery();
  });
}

function runQuery() {
  if (!currentStore) return;

  const metric = document.getElementById('queryMetric')?.value;
  const agg = document.getElementById('queryAgg')?.value || undefined;
  const groupByVal = document.getElementById('queryGroupBy')?.value;
  const groupBy = groupByVal ? [groupByVal] : undefined;
  const stepMs = parseInt(document.getElementById('queryStep')?.value || '0', 10);
  const step = stepMs > 0 ? BigInt(stepMs) * NS_PER_MS : undefined;
  const transform = document.getElementById('queryTransform')?.value || undefined;

  const ids = currentStore.matchLabel('__name__', metric);
  if (ids.length === 0) return;

  let minT = BigInt('9223372036854775807');
  let maxT = -minT;
  for (const id of ids) {
    const data = currentStore.read(id, -minT, minT);
    if (data.timestamps.length > 0) {
      if (data.timestamps[0] < minT) minT = data.timestamps[0];
      if (data.timestamps[data.timestamps.length - 1] > maxT)
        maxT = data.timestamps[data.timestamps.length - 1];
    }
  }

  const t0 = performance.now();
  const result = currentEngine.query(currentStore, {
    metric,
    start: minT,
    end: maxT,
    agg,
    groupBy,
    step,
    transform: transform || undefined,
    matchers: activeMatchers.length > 0 ? activeMatchers : undefined,
  });
  const queryTime = performance.now() - t0;

  showSection('section-results');

  document.getElementById('qStatScannedSeries').innerHTML = `Scanned: <strong>${result.scannedSeries}</strong> series`;
  document.getElementById('qStatScannedSamples').innerHTML = `Samples: <strong>${result.scannedSamples.toLocaleString()}</strong>`;
  document.getElementById('qStatResultSeries').innerHTML = `Result: <strong>${result.series.length}</strong> series`;
  document.getElementById('qStatQueryTime').innerHTML = `Time: <strong>${queryTime.toFixed(1)} ms</strong>`;

  const transformLabel = transform ? `${transform}(${metric})` : metric;
  const aggLabel = agg ? `${agg}(${transformLabel})` : transformLabel;
  const groupLabel = groupBy ? ` by ${groupBy.join(', ')}` : '';
  const stepLabel = step ? ` [${formatDuration(stepMs)} step]` : '';
  const chartTitle = `${aggLabel}${groupLabel}${stepLabel}`;

  renderChart(document.getElementById('chartCanvas'), result.series, chartTitle);
  setupChartTooltip();

  const legendEl = document.getElementById('chartLegend');
  if (legendEl) {
    legendEl.innerHTML = '';
    for (let i = 0; i < result.series.length; i++) {
      const s = result.series[i];
      const color = CHART_COLORS[i % CHART_COLORS.length];
      const labelStr = [...s.labels]
        .filter(([k]) => k !== '__name__')
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ') || 'all';
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = `<span class="legend-swatch" style="background:${color}"></span>${labelStr} (${s.timestamps.length.toLocaleString()} pts)`;
      legendEl.appendChild(item);
    }
  }
}

// ── Resize handler ────────────────────────────────────────────────────

let resizeController = null;
function installResizeListener() {
  if (resizeController) resizeController.abort();
  resizeController = new AbortController();
  window.addEventListener('resize', () => {
    const resultsSection = document.getElementById('section-results');
    if (currentStore && resultsSection && !resultsSection.hidden) runQuery();
  }, { signal: resizeController.signal });
}
installResizeListener();

// ── WASM init + auto-load ─────────────────────────────────────────────

loadWasm().then((ok) => {
  const statusEls = document.querySelectorAll('.wasm-status-badge');
  for (const el of statusEls) {
    el.style.display = 'inline-block';
    if (ok) {
      el.className = 'wasm-status-badge wasm-ok';
      el.textContent = '✓ WASM';
    } else {
      el.className = 'wasm-status-badge wasm-err';
      el.textContent = '✗ WASM unavailable';
    }
  }
  // Disable column options if WASM unavailable
  if (!ok) {
    document.querySelectorAll('option[value="column"]').forEach(opt => {
      opt.disabled = true;
      opt.textContent += ' (WASM required)';
    });
  }

  // Render scenario cards
  _renderScenarioCards();

  // Auto-load first scenario
  const firstScenario = SCENARIOS[0];
  requestAnimationFrame(() => {
    setTimeout(() => {
      const firstCard = document.querySelector('.scenario-card');
      loadScenario(firstScenario, firstCard);
    }, 100);
  });
});
