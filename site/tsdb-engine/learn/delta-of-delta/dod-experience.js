/**
 * Delta-of-Delta Timestamp Compression — Interactive Experience
 *
 * Demonstrates Gorilla-style timestamp encoding:
 *   Raw ts → Delta → Delta-of-Delta → ZigZag → Tier-based variable-width encoding
 */

import {
  $, el, buildBreadcrumb, buildStat, fmt, fmtBytes, zigzagEncode, generateSamples,
} from '../shared.js';

/* ─── Constants ───────────────────────────────────────────────────── */

const SAMPLE_COUNT = 24;

const TIER_DEFS = [
  { id: 0, label: '1-bit',  prefix: '0',    prefixBits: 1, dataBits: 0,  maxZZ: 0,    color: 'var(--tier-0)' },
  { id: 1, label: '9-bit',  prefix: '10',   prefixBits: 2, dataBits: 7,  maxZZ: 127,  color: 'var(--tier-1)' },
  { id: 2, label: '12-bit', prefix: '110',  prefixBits: 3, dataBits: 9,  maxZZ: 511,  color: 'var(--tier-2)' },
  { id: 3, label: '16-bit', prefix: '1110', prefixBits: 4, dataBits: 12, maxZZ: 4095, color: 'var(--tier-3)' },
  { id: 4, label: '68-bit', prefix: '1111', prefixBits: 4, dataBits: 64, maxZZ: Infinity, color: 'var(--tier-4)' },
];

const TIER_TOTAL_BITS = TIER_DEFS.map(t => t.prefixBits + t.dataBits);

/* ─── State ───────────────────────────────────────────────────────── */

let intervalSec = 15;
let jitterMs = 0;
let data = null;   // { timestamps, rows, tierCounts, totalBits, headerBits }

/* ─── Algorithm ───────────────────────────────────────────────────── */

function classifyTier(zzValue) {
  const zz = Number(zzValue);
  if (zz === 0) return 0;
  if (zz <= 127) return 1;
  if (zz <= 511) return 2;
  if (zz <= 4095) return 3;
  return 4;
}

function computeData() {
  const intervalNs = BigInt(intervalSec) * 1_000_000_000n;
  const { timestamps } = generateSamples('gauge', SAMPLE_COUNT, {
    interval: intervalNs,
    jitter: jitterMs,
  });

  const rows = [];
  const tierCounts = [0, 0, 0, 0, 0];
  let totalBitStreamBits = 0;

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const ts = timestamps[i];

    if (i === 0) {
      // First timestamp: stored as 8 bytes in header
      rows.push({
        idx: i, ts, delta: null, dod: null, zz: null,
        tier: -1, tierLabel: 'header', prefix: '—', bits: 64,
        note: 'stored in header',
      });
      continue;
    }

    const delta = ts - timestamps[i - 1];

    if (i === 1) {
      // First delta: stored raw in bit stream (14 bits with prefix to be safe,
      // but for this visualization we treat it as a raw delta value).
      // In Gorilla paper, first delta uses a fixed bit width. We'll show it
      // going through the tier system like subsequent values for clarity.
      // Actually, per the spec description in the prompt: "First delta stored as raw value"
      // We'll represent it going through normal tier encoding for educational value,
      // since the ΔoΔ concept starts at i=2.
      rows.push({
        idx: i, ts, delta, dod: null, zz: null,
        tier: -1, tierLabel: 'Δ raw', prefix: '—', bits: 64,
        note: 'first delta (raw)',
      });
      totalBitStreamBits += 64;
      continue;
    }

    const prevDelta = timestamps[i - 1] - timestamps[i - 2];
    const dod = delta - prevDelta;
    const zz = zigzagEncode(dod);
    const tier = classifyTier(zz);
    tierCounts[tier]++;
    const bits = TIER_TOTAL_BITS[tier];
    totalBitStreamBits += bits;

    rows.push({
      idx: i, ts, delta, dod, zz,
      tier,
      tierLabel: TIER_DEFS[tier].label,
      prefix: TIER_DEFS[tier].prefix,
      bits,
      note: null,
    });
  }

  // Wire format: 10-byte header (2B count u16 BE + 8B first ts i64 BE) + bit stream
  const headerBits = 10 * 8; // 80 bits
  const totalBits = headerBits + totalBitStreamBits;

  return { timestamps, rows, tierCounts, totalBits, headerBits, totalBitStreamBits };
}

/* ─── Formatters ──────────────────────────────────────────────────── */

function fmtTimestamp(ts) {
  const ms = Number(ts / 1_000_000n);
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const frac = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${frac}`;
}

function fmtNs(ns) {
  const n = Number(ns);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(3)} s`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} ms`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)} µs`;
  return `${n} ns`;
}

/* ─── Render Functions ────────────────────────────────────────────── */

function renderTable() {
  const tbody = $('#dod-tbody');
  tbody.innerHTML = '';

  for (const row of data.rows) {
    const tr = document.createElement('tr');

    if (row.tier >= 0) {
      tr.className = `tier-row-${row.tier}`;
    } else {
      tr.className = 'tier-row-header';
    }

    // #
    tr.appendChild(el('td', { class: 'dod-idx' }, String(row.idx)));

    // Timestamp
    tr.appendChild(el('td', { class: 'dod-ts' }, fmtTimestamp(row.ts)));

    // Delta
    if (row.delta === null) {
      tr.appendChild(el('td', { class: 'dod-na' }, '—'));
    } else {
      tr.appendChild(el('td', {}, fmtNs(Number(row.delta))));
    }

    // ΔoΔ
    if (row.dod === null) {
      tr.appendChild(el('td', { class: 'dod-na' }, '—'));
    } else {
      const dodStr = fmtNs(Number(row.dod));
      const dodTd = el('td', {}, dodStr);
      if (Number(row.dod) === 0) dodTd.style.color = 'var(--tier-0)';
      tr.appendChild(dodTd);
    }

    // ZigZag
    if (row.zz === null) {
      tr.appendChild(el('td', { class: 'dod-na' }, '—'));
    } else {
      tr.appendChild(el('td', {}, String(row.zz)));
    }

    // Tier badge
    if (row.tier >= 0) {
      const badge = el('span', { class: `xp-badge dod-tier-badge t${row.tier}` }, row.tierLabel);
      tr.appendChild(el('td', {}, badge));
    } else {
      const badge = el('span', {
        class: 'xp-badge dod-tier-badge',
        style: { background: 'rgba(139, 92, 246, 0.15)', color: 'var(--region-header)' },
      }, row.tierLabel);
      tr.appendChild(el('td', {}, badge));
    }

    // Prefix
    tr.appendChild(el('td', { class: 'dod-prefix' }, row.prefix));

    // Bits
    const bitsTd = el('td', { class: 'dod-bits' }, String(row.bits));
    if (row.tier >= 0) bitsTd.style.color = TIER_DEFS[row.tier].color;
    else bitsTd.style.color = 'var(--region-header)';
    tr.appendChild(bitsTd);

    tbody.appendChild(tr);
  }
}

function renderTierBar() {
  const bar = $('#tier-bar');
  const legend = $('#tier-legend');
  bar.innerHTML = '';
  legend.innerHTML = '';

  // Only count tier-encoded values (skip header rows)
  const tierTotal = data.tierCounts.reduce((a, b) => a + b, 0);

  for (let t = 0; t < 5; t++) {
    const count = data.tierCounts[t];
    if (count === 0) continue;
    const pct = (count / tierTotal) * 100;
    const seg = el('div', {
      class: `dod-tier-seg seg-${t}`,
      style: { flexBasis: `${pct}%` },
    }, pct >= 8 ? `${count}` : '');
    if (pct >= 15) {
      seg.textContent = `${count} (${Math.round(pct)}%)`;
    }
    bar.appendChild(seg);
  }

  // Legend
  for (let t = 0; t < 5; t++) {
    const def = TIER_DEFS[t];
    const item = el('div', { class: 'dod-tier-legend-item' },
      el('span', { class: `dod-tier-dot d${t}` }),
      el('span', {}, `${def.label} (${TIER_TOTAL_BITS[t]}b) — ${data.tierCounts[t]}`),
    );
    legend.appendChild(item);
  }
}

function renderBitCostChart() {
  const chart = $('#bitcost-chart');
  chart.innerHTML = '';

  const maxBits = 68;

  for (const row of data.rows) {
    const barRow = el('div', { class: 'dod-bitcost-row' });

    barRow.appendChild(el('div', { class: 'dod-bitcost-label' }, String(row.idx)));

    const widthPct = (row.bits / maxBits) * 100;
    const tierClass = row.tier >= 0 ? `bc-${row.tier}` : 'bc-header';
    const barEl = el('div', { class: `dod-bitcost-bar ${tierClass}`, style: { width: `${widthPct}%` } });
    const wrap = el('div', { class: 'dod-bitcost-bar-wrap' }, barEl);
    barRow.appendChild(wrap);

    barRow.appendChild(el('div', { class: 'dod-bitcost-bits' }, `${row.bits}b`));

    chart.appendChild(barRow);
  }
}

function renderSummary() {
  const statsRow = $('#summary-stats');
  statsRow.innerHTML = '';

  const rawBytes = SAMPLE_COUNT * 8;
  const compressedBits = data.totalBits;
  const compressedBytes = Math.ceil(compressedBits / 8);
  const ratio = rawBytes / compressedBytes;

  // Average bits per timestamp for the tier-encoded portion
  const tierTotal = data.tierCounts.reduce((a, b) => a + b, 0);
  const tierBits = data.totalBitStreamBits - 64; // subtract first delta raw bits
  const avgBits = tierTotal > 0 ? tierBits / tierTotal : 0;

  const stats = [
    { label: 'Raw Size', value: fmtBytes(rawBytes), unit: `${SAMPLE_COUNT} × 8 B` },
    { label: 'Compressed', value: fmtBytes(compressedBytes), unit: `${fmt(compressedBits)} bits` },
    { label: 'Ratio', value: `${ratio.toFixed(1)}×`, unit: 'smaller' },
    { label: 'Avg Bits/TS', value: avgBits.toFixed(1), unit: 'bits (ΔoΔ only)' },
  ];

  for (const s of stats) {
    const stat = buildStat(s.label, s.value, s.unit);
    if (s.label === 'Ratio') {
      stat.querySelector('.xp-stat-value').style.color = ratio >= 10 ? 'var(--xp-success)' : ratio >= 4 ? 'var(--xp-accent)' : 'var(--xp-warn)';
    }
    statsRow.appendChild(stat);
  }

  // Jitter story
  const story = $('#jitter-story');
  const t0Pct = tierTotal > 0 ? Math.round((data.tierCounts[0] / tierTotal) * 100) : 0;

  if (jitterMs === 0) {
    story.innerHTML = `With <strong>0 ms jitter</strong>, ${t0Pct}% of deltas-of-deltas are exactly zero — each costs only <strong>1 bit</strong>. The entire timestamp column compresses to <strong>${ratio.toFixed(0)}× smaller</strong> than raw 8-byte timestamps.`;
  } else {
    const warnClass = avgBits > 10 ? ' warn' : '';
    story.innerHTML = `With <strong class="${warnClass}">${fmt(jitterMs)} ms jitter</strong>, only ${t0Pct}% of ΔoΔ values are zero. Average encoding cost rises to <strong class="${warnClass}">${avgBits.toFixed(1)} bits/timestamp</strong>. Compression ratio: <strong>${ratio.toFixed(1)}×</strong>.`;
  }
}

function renderAll() {
  data = computeData();
  renderTable();
  renderTierBar();
  renderBitCostChart();
  renderSummary();
}

/* ─── Event Wiring ────────────────────────────────────────────────── */

function init() {
  // Breadcrumb
  $('#breadcrumb-nav').innerHTML = buildBreadcrumb('Delta‑of‑Delta');

  // Interval select
  const intervalSelect = $('#interval-select');
  intervalSelect.addEventListener('change', () => {
    intervalSec = Number(intervalSelect.value);
    renderAll();
  });

  // Jitter slider — throttled to rAF
  const jitterSlider = $('#jitter-slider');
  const jitterDisplay = $('#jitter-value');
  let rafPending = false;

  jitterSlider.addEventListener('input', () => {
    jitterMs = Number(jitterSlider.value);
    jitterDisplay.textContent = `${fmt(jitterMs)} ms`;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        renderAll();
        rafPending = false;
      });
    }
  });

  // Regenerate button
  $('#btn-regenerate').addEventListener('click', renderAll);

  // Initial render
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
