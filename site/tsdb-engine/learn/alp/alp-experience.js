/**
 * ALP Compression — Interactive Experience
 *
 * Walks through the Adaptive Lossless floating-Point pipeline:
 *   Exponent Scan → Quantize → Frame-of-Reference → Bit-Width → Pack
 */

import { $, $$, buildBreadcrumb, el, fmt, fmtBytes, initGlossary, Stepper } from "../shared.js";

/* ─── Sample Data Presets ─────────────────────────────────────────── */

const PRESETS = {
  temperature: {
    label: "🌡️ Temperature",
    values: [
      20.5, 21.3, 20.8, 21.1, 20.95, 21.45, 20.7, 21.2, 20.6, 21.35, 20.9, 21.05, 20.75, 21.4,
      20.85, 21.15, 20.55, 21.25, 20.65, 21.0, 20.8, 21.3, 20.7, 21.1,
    ],
  },
  percentage: {
    label: "📊 Percentages",
    values: [
      45.2, 67.8, 89.1, 34.5, 72.3, 56.7, 91.4, 23.6, 78.9, 45.1, 62.3, 88.7, 31.2, 74.5, 58.9,
      93.2, 41.7, 69.3, 85.6, 27.8, 76.1, 54.3, 92.8, 38.4,
    ],
  },
  counter: {
    label: "🔢 Counter",
    values: [
      1000, 1005, 1010, 1015, 1020, 1025, 1030, 1035, 1040, 1045, 1050, 1055, 1060, 1065, 1070,
      1075, 1080, 1085, 1090, 1095, 1100, 1105, 1110, 1115,
    ],
  },
  custom: {
    label: "✏️ Custom",
    values: null,
  },
};

/* ─── ALP Algorithm ───────────────────────────────────────────────── */

const POW10 = Array.from({ length: 19 }, (_, i) => 10 ** i);

function alpRoundTrips(val, exp) {
  const scaled = Math.round(val * POW10[exp]);
  return scaled / POW10[exp] === val;
}

function findExponent(values) {
  for (let e = 0; e <= 18; e++) {
    if (values.every((v) => alpRoundTrips(v, e))) return e;
  }
  return -1;
}

function alpEncode(values) {
  const exp = findExponent(values);
  const exceptions = [];
  const integers = [];

  if (exp === -1) {
    // All exceptions
    for (let i = 0; i < values.length; i++) exceptions.push({ idx: i, value: values[i] });
    return {
      exp: 0,
      integers: new Array(values.length).fill(0),
      minInt: 0,
      offsets: new Array(values.length).fill(0),
      bitWidth: 0,
      exceptions,
      values,
      exponentScan: buildExponentScan(values),
    };
  }

  for (let i = 0; i < values.length; i++) {
    const scaled = Math.round(values[i] * POW10[exp]);
    if (scaled / POW10[exp] !== values[i]) {
      exceptions.push({ idx: i, value: values[i] });
      integers.push(0); // placeholder
    } else {
      integers.push(scaled);
    }
  }

  const nonExcIdxs = new Set(exceptions.map((e) => e.idx));
  const validInts = integers.filter((_, i) => !nonExcIdxs.has(i));
  const minInt = validInts.length > 0 ? Math.min(...validInts) : 0;

  const offsets = integers.map((v, i) => (nonExcIdxs.has(i) ? 0 : v - minInt));

  const maxOffset = offsets.length > 0 ? Math.max(...offsets) : 0;
  const bitWidth = maxOffset === 0 ? 0 : Math.ceil(Math.log2(maxOffset + 1));

  return {
    exp,
    integers,
    minInt,
    offsets,
    bitWidth,
    exceptions,
    values,
    exponentScan: buildExponentScan(values),
  };
}

function buildExponentScan(values) {
  const rows = [];
  const winExp = findExponent(values);
  for (let e = 0; e <= Math.min(18, Math.max(5, winExp + 1)); e++) {
    const samples = values.slice(0, 3).map((v) => {
      const scaled = Math.round(v * POW10[e]);
      const trips = scaled / POW10[e] === v;
      return { original: v, scaled, trips };
    });
    const allTrip = values.every((v) => alpRoundTrips(v, e));
    rows.push({ exp: e, samples, allTrip, isWinner: e === winExp });
  }
  return rows;
}

function wireSize(encoded) {
  const headerBytes = 14;
  const packedBits = (encoded.values.length - encoded.exceptions.length) * encoded.bitWidth;
  const packedBytes = Math.ceil(packedBits / 8);
  const excPosBytes = encoded.exceptions.length * 2;
  const excValBytes = encoded.exceptions.length * 8;
  return {
    headerBytes,
    packedBytes,
    excPosBytes,
    excValBytes,
    total: headerBytes + packedBytes + excPosBytes + excValBytes,
  };
}

/* ─── State ───────────────────────────────────────────────────────── */

let currentValues = [];
let encoded = null;
let stepper;

/* ─── DOM Init ────────────────────────────────────────────────────── */

function init() {
  $("#breadcrumb-nav").innerHTML = buildBreadcrumb("ALP Compression");

  const stages = [
    { icon: "🔍", label: "Scan", subtitle: "find the right multiplier" },
    { icon: "×10ᵉ", label: "Quantize", subtitle: "multiply decimals to integers" },
    { icon: "−min", label: "Frame-of-Ref", subtitle: "subtract minimum, shrink range" },
    { icon: "🔢", label: "Bit-Width", subtitle: "calculate minimum bits needed" },
    { icon: "📦", label: "Pack", subtitle: "write the compressed stream" },
  ];

  const pipelineBar = $("#pipeline-bar");
  stages.forEach((s, i) => {
    if (i > 0)
      pipelineBar.appendChild(el("span", { class: "xp-pipe-arrow", "aria-hidden": "true" }, "→"));
    const stageEl = el(
      "div",
      {
        class: "xp-pipe-stage clickable",
        "data-stage": String(i),
        onClick: () => stepper.goto(i),
      },
      el("span", { class: "stage-icon" }, s.icon),
      el("span", { class: "stage-label" }, s.label),
      el("small", { class: "stage-subtitle" }, s.subtitle)
    );
    pipelineBar.appendChild(stageEl);
  });

  stepper = new Stepper(5, onStageChange);

  buildPatternButtons();
  selectPreset("temperature");

  $("#btn-prev").addEventListener("click", () => stepper.prev());
  $("#btn-next").addEventListener("click", () => stepper.next());
  $("#btn-play").addEventListener("click", () => stepper.play(1800));
  $("#btn-reset").addEventListener("click", () => {
    stepper.stop();
    stepper.reset();
  });
  $("#apply-custom").addEventListener("click", applyCustom);

  initGlossary();
}

/* ─── Pattern Buttons ─────────────────────────────────────────────── */

function buildPatternButtons() {
  const container = $("#pattern-buttons");
  for (const [key, preset] of Object.entries(PRESETS)) {
    const btn = el(
      "button",
      {
        class: "xp-btn",
        "data-preset": key,
        onClick: () => selectPreset(key),
      },
      preset.label
    );
    container.appendChild(btn);
  }
}

function selectPreset(key) {
  $$("[data-preset]").forEach((b) => {
    b.classList.toggle("active", b.dataset.preset === key);
  });

  const customWrap = $("#custom-input-wrap");
  if (key === "custom") {
    customWrap.hidden = false;
    const ta = $("#custom-textarea");
    if (!ta.value.trim()) {
      ta.value =
        "3.14, 2.71, 1.41, 98.6, 0.577, 42.0, 7.77, 12.34, 56.78, 90.12, 3.14, 6.28, 9.42, 12.56, 15.70, 18.84";
    }
    applyCustom();
    return;
  }
  customWrap.hidden = true;
  setValues(PRESETS[key].values);
}

function applyCustom() {
  const raw = $("#custom-textarea").value;
  const parsed = raw
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (parsed.length < 2) return;
  setValues(parsed);
}

/* ─── Set Values & Re-encode ──────────────────────────────────────── */

function setValues(values) {
  currentValues = values;
  encoded = alpEncode(values);
  renderValueChips();
  stepper.stop();
  stepper.reset();
  $("#summary-section").hidden = true;
}

function renderValueChips() {
  const scroll = $("#values-scroll");
  scroll.innerHTML = "";
  const excIdxs = new Set((encoded?.exceptions || []).map((e) => e.idx));
  currentValues.forEach((v, i) => {
    const isExc = excIdxs.has(i);
    const chip = el(
      "div",
      { class: `alp-val-chip${isExc ? " exception" : ""}` },
      el("span", { class: "idx" }, `#${i}`),
      el("span", { class: "val" }, formatNum(v))
    );
    scroll.appendChild(chip);
  });
}

/* ─── Stage Change Handler ────────────────────────────────────────── */

function onStageChange(stage) {
  // Update pipeline bar
  $$(".xp-pipe-stage").forEach((el, i) => {
    el.classList.remove("active", "done");
    if (i === stage) el.classList.add("active");
    else if (i < stage) el.classList.add("done");
  });

  // Hide all panels
  $$(".alp-panel").forEach((p) => {
    p.hidden = true;
  });

  if (stage === -1) {
    $("#summary-section").hidden = true;
    renderOrientationCard();
    return;
  }

  // Show relevant panel
  const panels = ["panel-scan", "panel-quantize", "panel-for", "panel-bitpack", "panel-exceptions"];

  if (stage <= 4) {
    const p = $(`#${panels[stage]}`);
    p.hidden = false;
    // Re-render the content with fresh animation
    p.style.animation = "none";
    // eslint-disable-next-line no-unused-expressions
    p.offsetHeight; // trigger reflow
    p.style.animation = "";
  }

  switch (stage) {
    case 0:
      renderExponentScan();
      break;
    case 1:
      renderQuantize();
      break;
    case 2:
      renderFrameOfRef();
      break;
    case 3:
      renderBitWidthPack();
      break;
    case 4:
      renderFinalSummary();
      break;
  }
}

/* ─── Step –1: Orientation Card ──────────────────────────────────── */

function renderOrientationCard() {
  const panel = $("#panel-orient");
  panel.hidden = false;
  panel.innerHTML = `
    <div class="xp-card xp-card-raised">
      <h3>How ALP Works</h3>
      <p>ALP compresses decimal metrics in 5 stages:</p>
      <ol style="margin: 12px 0 16px 20px; line-height: 2;">
        <li><strong>Scan</strong> — try multipliers to find which power of 10 converts all values to exact integers</li>
        <li><strong><span class="xp-term" data-term="quantize">Quantize</span></strong> — multiply every value by that power (e.g. 34.5 → 3450)</li>
        <li><strong><span class="xp-term" data-term="frame-of-reference">Frame-of-Reference</span></strong> — subtract the minimum so all numbers are small offsets</li>
        <li><strong>Bit-Width</strong> — calculate the minimum bits needed to store the largest offset</li>
        <li><strong><span class="xp-term" data-term="bit-packing">Pack</span></strong> — write values using only those bits, back-to-back</li>
      </ol>
      <p style="color: var(--xp-text-muted);">Click <strong>Next →</strong> to begin</p>
    </div>`;
}

/* ─── Stage 0: Exponent Scan ──────────────────────────────────────── */

function renderExponentScan() {
  const panel = $("#panel-scan");
  const scan = encoded.exponentScan;
  const winExp = encoded.exp;

  let html = `
    <div class="xp-card xp-card-raised">
      <h3>Exponent Scan</h3>
      <p>Try each <span class="xp-term" data-term="exponent">exponent</span> <code class="xp-code">e = 0…${scan.length - 1}</code>:
        multiply by 10<sup>e</sup>, round, and check if the value round-trips exactly.
        ${winExp >= 0 ? `Smallest working <span class="xp-term" data-term="exponent">exponent</span>: <strong class="alp-check">e = ${winExp}</strong>` : '<strong class="alp-cross">No exponent works — all values become exceptions</strong>'}
      </p>
      <div style="overflow-x:auto">
      <table class="alp-exp-table">
        <thead><tr>
          <th>e</th><th>10<sup>e</sup></th>
          ${scan[0].samples.map((_, j) => `<th>val[${j}] × 10<sup>e</sup></th>`).join("")}
          <th>Round-trips?</th>
        </tr></thead>
        <tbody>`;

  for (const row of scan) {
    const cls = row.isWinner ? ' class="winner"' : "";
    html += `<tr${cls}>
      <td>${row.exp}</td>
      <td>${fmt(POW10[row.exp])}</td>`;
    for (const s of row.samples) {
      const icon = s.trips
        ? '<span class="alp-check">✓</span>'
        : '<span class="alp-cross">✗</span>';
      html += `<td>${fmt(s.scaled)} ${icon}</td>`;
    }
    html += `<td>${
      row.allTrip ? '<span class="alp-check">✓ All</span>' : '<span class="alp-cross">✗</span>'
    }</td></tr>`;
  }

  html += `</tbody></table></div></div>`;
  panel.innerHTML = html;
}

/* ─── Stage 1: Quantize ───────────────────────────────────────────── */

function renderQuantize() {
  const panel = $("#panel-quantize");
  const excIdxs = new Set(encoded.exceptions.map((e) => e.idx));

  let gridHTML = `
    <div class="alp-quant-grid">
      <div class="hdr">Original (8-byte float)</div>
      <div class="hdr"></div>
      <div class="hdr">× 10<sup>${encoded.exp}</sup> → integer</div>`;

  currentValues.forEach((v, i) => {
    const isExc = excIdxs.has(i);
    const intVal = encoded.integers[i];
    gridHTML += `
      <div class="from${isExc ? " exception" : ""}">${formatNum(v)}</div>
      <div class="arrow">→</div>
      <div class="to${isExc ? " exception" : ""}">${isExc ? "⚠ exception" : fmt(intVal)}</div>`;
  });

  gridHTML += "</div>";

  panel.innerHTML = `
    <div class="xp-card xp-card-raised">
      <h3>Integer <span class="xp-term" data-term="quantize">Quantization</span></h3>
      <p>Multiply every value by <code class="xp-code">10<sup>${encoded.exp}</sup> = ${fmt(POW10[encoded.exp])}</code> and round to get exact integers.
        ${encoded.exceptions.length > 0 ? `<span class="alp-cross">${encoded.exceptions.length} value(s) don't round-trip — stored as <span class="xp-term" data-term="exceptions">exceptions</span>.</span>` : ""}
      </p>
      ${gridHTML}
    </div>`;
}

/* ─── Stage 2: Frame-of-Reference ─────────────────────────────────── */

function renderFrameOfRef() {
  const panel = $("#panel-for");
  const excIdxs = new Set(encoded.exceptions.map((e) => e.idx));
  const validInts = encoded.integers.filter((_, i) => !excIdxs.has(i));
  const maxInt = validInts.length > 0 ? Math.max(...validInts) : 0;
  const maxOffset = encoded.offsets.length > 0 ? Math.max(...encoded.offsets) : 0;
  const intRange = maxInt - encoded.minInt;

  const origPct = 100;
  const offsetPct = intRange > 0 ? Math.max(8, (maxOffset / maxInt) * 100) : 8;

  let offsetChips = "";
  currentValues.forEach((_, i) => {
    if (excIdxs.has(i)) return;
    offsetChips += `
      <div class="alp-offset-chip">
        <span class="lbl">#${i}</span>
        <span>${fmt(encoded.offsets[i])}</span>
      </div>`;
  });

  panel.innerHTML = `
    <div class="xp-card xp-card-raised">
      <h3><span class="xp-term" data-term="frame-of-reference">Frame-of-Reference</span></h3>
      <p>Subtract the minimum integer <code class="xp-code">${fmt(encoded.minInt)}</code>
         so all offsets start at 0. Range shrinks from
         <strong>${fmt(encoded.minInt)}–${fmt(maxInt)}</strong> to
         <strong>0–${fmt(maxOffset)}</strong>.
      </p>
      <div class="alp-for-visual">
        <div>
          <div class="alp-range-label">Original integer range</div>
          <div class="alp-range-bar">
            <div class="alp-range-fill" style="width:${origPct}%; background: rgba(96,165,250,0.25); color: var(--xp-accent-light);">
              ${fmt(encoded.minInt)} … ${fmt(maxInt)}
            </div>
          </div>
        </div>
        <div>
          <div class="alp-range-label">After subtracting min</div>
          <div class="alp-range-bar">
            <div class="alp-range-fill" style="width:${offsetPct}%; background: rgba(52,211,153,0.25); color: var(--xp-success);">
              0 … ${fmt(maxOffset)}
            </div>
          </div>
        </div>
      </div>
      <h3 style="font-size:14px; margin-top:16px;">Offsets</h3>
      <div class="alp-for-offsets">${offsetChips}</div>
    </div>`;
}

/* ─── Stage 3–4: Bit-Width + Packing ──────────────────────────────── */

function renderBitWidthPack() {
  const panel = $("#panel-bitpack");
  const excIdxs = new Set(encoded.exceptions.map((e) => e.idx));
  const bw = encoded.bitWidth;
  const validCount = currentValues.length - encoded.exceptions.length;

  // Build packed bits display
  let bitsHTML = "";
  let valIdx = 0;
  currentValues.forEach((_, i) => {
    if (excIdxs.has(i)) return;
    const offset = encoded.offsets[i];
    const bits = offset.toString(2).padStart(bw, "0");
    const parity = valIdx % 2 === 0 ? "v-even" : "v-odd";
    for (let b = 0; b < bw; b++) {
      bitsHTML += `<div class="alp-packed-bit ${parity}" data-b="${bits[b]}" title="val[${i}] bit ${b}">${bits[b]}</div>`;
    }
    valIdx++;
  });

  const rawBits = currentValues.length * 64;
  const packedBits = validCount * bw;
  const ratio = packedBits > 0 ? (rawBits / packedBits).toFixed(1) : "∞";

  panel.innerHTML = `
    <div class="xp-card xp-card-raised">
      <h3><span class="xp-term" data-term="bit-packing">Bit-Width &amp; Packing</span></h3>
      <p>Maximum offset is <code class="xp-code">${fmt(Math.max(...encoded.offsets))}</code>,
         which needs <code class="xp-code">${bw} bits</code> to represent.
         Each value is packed at exactly ${bw} bits — no wasted space.
      </p>
      <div class="xp-stats-row" style="margin-bottom:16px">
        <div class="xp-stat">
          <span class="xp-stat-label">Bit width</span>
          <span class="xp-stat-value">${bw}<span class="xp-stat-unit"> bits</span></span>
        </div>
        <div class="xp-stat">
          <span class="xp-stat-label">Raw bits</span>
          <span class="xp-stat-value">${fmt(rawBits)}<span class="xp-stat-unit"> bits</span></span>
        </div>
        <div class="xp-stat">
          <span class="xp-stat-label">Packed bits</span>
          <span class="xp-stat-value tier-0">${fmt(packedBits)}<span class="xp-stat-unit"> bits</span></span>
        </div>
        <div class="xp-stat">
          <span class="xp-stat-label">Ratio (values only)</span>
          <span class="xp-stat-value alp-ratio-highlight">${ratio}×</span>
        </div>
      </div>
      ${
        bw > 0
          ? `
      <h3 style="font-size:14px;">Packed Bit Stream</h3>
      <p>Each color alternates per value. ${bw} bits per value, read left-to-right.</p>
      <div class="alp-bitpack-wrap">
        <div class="alp-bitpack-grid">${bitsHTML}</div>
      </div>
      <div class="alp-bitpack-legend">
        <span><span class="swatch" style="background:rgba(96,165,250,0.3)"></span>Even values</span>
        <span><span class="swatch" style="background:rgba(52,211,153,0.3)"></span>Odd values</span>
      </div>`
          : '<p class="tier-0" style="font-weight:600">All values are identical — 0 bits needed!</p>'
      }
    </div>`;

  // Also show exceptions if any
  renderExceptionsInline();
}

function renderExceptionsInline() {
  const panel = $("#panel-exceptions");
  if (encoded.exceptions.length === 0) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  let items = "";
  for (const exc of encoded.exceptions) {
    items += `
      <div class="alp-exc-item">
        <span class="pos">pos ${exc.idx}</span>
        <span class="raw">${formatNum(exc.value)}</span>
        <span class="cost">8 bytes (8-byte float)</span>
      </div>`;
  }

  panel.innerHTML = `
    <div class="xp-card xp-card-raised" style="border-color: rgba(251,191,36,0.25);">
      <h3>⚠ <span class="xp-term" data-term="exceptions">Exceptions</span></h3>
      <p>${encoded.exceptions.length} value(s) didn't round-trip with <span class="xp-term" data-term="exponent">exponent</span>
         <code class="xp-code">e = ${encoded.exp}</code>.
         Each is stored as a raw 64-bit float (8 bytes) plus a 2-byte position index.</p>
      <div class="alp-exc-list">${items}</div>
    </div>`;
}

/* ─── Final Summary (after stage 4) ───────────────────────────────── */

function renderFinalSummary() {
  const summary = $("#summary-section");
  summary.hidden = false;
  summary.style.animation = "none";
  // eslint-disable-next-line no-unused-expressions
  summary.offsetHeight;
  summary.style.animation = "";
  summary.classList.add("xp-animate-in");

  const wire = wireSize(encoded);
  const rawSize = currentValues.length * 8;
  const ratio = (rawSize / wire.total).toFixed(2);
  const bpv = ((wire.total * 8) / currentValues.length).toFixed(1);

  // Stats row
  const statsRow = $("#summary-stats");
  statsRow.innerHTML = "";
  const stats = [
    { label: "Raw size", value: fmtBytes(rawSize), unit: `${currentValues.length} × 8B` },
    { label: "Compressed", value: fmtBytes(wire.total), unit: "" },
    { label: "Ratio", value: `${ratio}×`, unit: "", cls: "alp-ratio-highlight" },
    { label: "Bits / value", value: bpv, unit: "bits" },
    { label: "Exponent", value: `e=${encoded.exp}`, unit: "" },
    { label: "Bit width", value: `${encoded.bitWidth}`, unit: "bits" },
  ];

  for (const s of stats) {
    statsRow.appendChild(
      el(
        "div",
        { class: "xp-stat" },
        el("span", { class: "xp-stat-label" }, s.label),
        el(
          "span",
          { class: `xp-stat-value ${s.cls || ""}` },
          s.value,
          s.unit ? ` ` : "",
          s.unit ? el("span", { class: "xp-stat-unit" }, s.unit) : ""
        )
      )
    );
  }

  // Wire format bar
  const wireCard = $("#wire-format-card");
  const segments = [
    { cls: "seg-header", bytes: wire.headerBytes, label: `Header ${wire.headerBytes}B` },
    { cls: "seg-packed", bytes: wire.packedBytes, label: `Packed ${wire.packedBytes}B` },
  ];
  if (wire.excPosBytes > 0) {
    segments.push({
      cls: "seg-exc-pos",
      bytes: wire.excPosBytes,
      label: `Exc pos ${wire.excPosBytes}B`,
    });
    segments.push({
      cls: "seg-exc-val",
      bytes: wire.excValBytes,
      label: `Exc val ${wire.excValBytes}B`,
    });
  }

  let barHTML = '<h3 style="font-size:14px; margin-bottom:12px;">Wire Format</h3>';
  barHTML += '<div class="alp-wire-bar">';
  for (const seg of segments) {
    barHTML += `<div class="alp-wire-seg ${seg.cls}" style="flex:${seg.bytes}">${seg.label}</div>`;
  }
  barHTML += "</div>";

  barHTML += '<div class="alp-wire-legend">';
  barHTML += `<span><span class="dot" style="background:var(--region-header)"></span>Header (14B: count, exp, bit_width, min_int, exc_count)</span>`;
  barHTML += `<span><span class="dot" style="background:var(--region-values)"></span>Bit-packed offsets (${wire.packedBytes}B)</span>`;
  if (wire.excPosBytes > 0) {
    barHTML += `<span><span class="dot" style="background:var(--region-exceptions)"></span>Exception positions (${wire.excPosBytes}B)</span>`;
    barHTML += `<span><span class="dot" style="background:var(--xp-warn)"></span>Exception values (${wire.excValBytes}B)</span>`;
  }
  barHTML += "</div>";

  // Compression meter
  const meterPct = Math.min(100, (wire.total / rawSize) * 100);
  barHTML += `
    <div style="margin-top:20px">
      <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--xp-text-muted); margin-bottom:4px;">
        <span>Compressed: ${fmtBytes(wire.total)}</span>
        <span>Raw: ${fmtBytes(rawSize)}</span>
      </div>
      <div class="xp-meter">
        <div class="xp-meter-fill" style="width:${meterPct}%"></div>
      </div>
    </div>`;

  wireCard.innerHTML = barHTML;

  // Animate the stat values
  $$(".xp-stat-value", summary).forEach((el) => {
    el.style.animation = "none";
    // eslint-disable-next-line no-unused-expressions
    el.offsetHeight;
    el.style.animation = "xp-fade-in 400ms ease both";
  });
}

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatNum(n) {
  if (Number.isInteger(n)) return fmt(n);
  // Show enough decimal places to be faithful
  const s = String(n);
  const decimals = s.includes(".") ? s.split(".")[1].length : 0;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(decimals, 6),
    maximumFractionDigits: 6,
  });
}

/* ─── Boot ────────────────────────────────────────────────────────── */

init();
