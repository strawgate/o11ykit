/**
 * XOR-Delta Value Compression — Interactive Experience
 *
 * Demonstrates Gorilla-style XOR value encoding:
 *   Raw float64 → XOR with previous → leading/trailing zero analysis
 *   → identical (1 bit) / reuse window (2+M bits) / new window (14+M bits)
 */

import {
  $,
  $$,
  buildBreadcrumb,
  buildStat,
  clz64,
  ctz64,
  drawSparkline,
  el,
  float64ToBits,
  fmt,
  fmtBytes,
  initGlossary,
} from "../shared.js";

/* ─── Constants ───────────────────────────────────────────────────── */

const SAMPLE_COUNT = 20;

const PATTERNS = [
  { id: "slow-sine", label: "Slow Sine", icon: "〜" },
  { id: "temperature", label: "Temperature", icon: "🌡" },
  { id: "random", label: "Random", icon: "🎲" },
  { id: "constant", label: "Constant", icon: "═" },
];

const ENC_COLORS = {
  first: "#8b5cf6",
  identical: "#34d399",
  reuse: "#60a5fa",
  new: "#fbbf24",
};

const ENC_LABELS = {
  first: "raw",
  identical: "identical",
  reuse: "reuse window",
  new: "new window",
};

/* ─── State ───────────────────────────────────────────────────────── */

let activePattern = "slow-sine";
let values = [];
let rows = [];
let selectedRow = -1;

/* ─── Signal Generation ───────────────────────────────────────────── */

function generateValues(pattern, count) {
  const vals = new Float64Array(count);
  switch (pattern) {
    case "slow-sine":
      for (let i = 0; i < count; i++) {
        vals[i] = Math.round(50 + Math.sin(i * 0.2) * 5);
      }
      break;
    case "temperature":
      for (let i = 0; i < count; i++) {
        vals[i] = Math.round((22 + Math.sin(i * 0.15) * 3 + (Math.random() - 0.5) * 0.5) * 10) / 10;
      }
      break;
    case "random":
      for (let i = 0; i < count; i++) {
        vals[i] = Math.random() * 200;
      }
      break;
    case "constant":
      for (let i = 0; i < count; i++) {
        vals[i] = 42.5;
      }
      break;
  }
  return vals;
}

/* ─── IEEE 754 → BigInt ───────────────────────────────────────────── */

function float64ToUint64(value) {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = value;
  const bytes = new Uint8Array(buf);
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

function bigIntToBitString(n) {
  let s = "";
  for (let i = 63; i >= 0; i--) {
    s += (n >> BigInt(i)) & 1n ? "1" : "0";
  }
  return s;
}

/* ─── XOR-Delta Encoding ──────────────────────────────────────────── */

function computeRows(vals) {
  const result = [];
  // Sentinel: no window established yet — forces "new window" for first XOR≠0
  let prevLeading = 255;
  let prevTrailing = 0;

  for (let i = 0; i < vals.length; i++) {
    const value = vals[i];
    const bits = float64ToBits(value);
    const uint64 = float64ToUint64(value);

    if (i === 0) {
      result.push({
        idx: 0,
        value,
        bits,
        uint64,
        xorBits: null,
        xorUint64: null,
        leadingZeros: null,
        trailingZeros: null,
        meaningfulBits: null,
        encoding: "first",
        cost: 64,
        windowLeading: null,
        windowTrailing: null,
        windowMeaningful: null,
      });
      continue;
    }

    const prevUint64 = float64ToUint64(vals[i - 1]);
    const xorUint64 = prevUint64 ^ uint64;
    const xorBits = bigIntToBitString(xorUint64);

    const lz = clz64(xorUint64);
    const tz = ctz64(xorUint64);
    const meaningful = xorUint64 === 0n ? 0 : 64 - lz - tz;

    let encoding, cost, windowLeading, windowTrailing, windowMeaningful;

    if (xorUint64 === 0n) {
      encoding = "identical";
      cost = 1;
      windowLeading = prevLeading;
      windowTrailing = prevTrailing;
      windowMeaningful = prevLeading === 255 ? 0 : 64 - prevLeading - prevTrailing;
    } else if (prevLeading !== 255 && lz >= prevLeading && tz >= prevTrailing) {
      encoding = "reuse";
      windowLeading = prevLeading;
      windowTrailing = prevTrailing;
      windowMeaningful = 64 - prevLeading - prevTrailing;
      cost = 2 + windowMeaningful;
    } else {
      encoding = "new";
      windowLeading = lz;
      windowTrailing = tz;
      windowMeaningful = meaningful;
      cost = 2 + 6 + 6 + meaningful; // 14 + M control/metadata overhead
      prevLeading = lz;
      prevTrailing = tz;
    }

    result.push({
      idx: i,
      value,
      bits,
      uint64,
      xorBits,
      xorUint64,
      leadingZeros: lz,
      trailingZeros: tz,
      meaningfulBits: meaningful,
      encoding,
      cost,
      windowLeading,
      windowTrailing,
      windowMeaningful,
    });
  }

  return result;
}

/* ─── Render: Pattern Picker ──────────────────────────────────────── */

function renderPatternPicker() {
  const container = $("#pattern-controls");
  container.innerHTML = "";

  for (const p of PATTERNS) {
    const btn = el(
      "button",
      {
        class: `xp-btn${p.id === activePattern ? " active" : ""}`,
        "data-pattern": p.id,
        onClick: () => {
          activePattern = p.id;
          selectedRow = -1;
          recompute();
        },
      },
      `${p.icon} ${p.label}`
    );
    container.appendChild(btn);
  }
}

function updatePatternButtons() {
  for (const btn of $$(".xp-btn[data-pattern]")) {
    btn.classList.toggle("active", btn.dataset.pattern === activePattern);
  }
}

/* ─── Render: Sparkline ───────────────────────────────────────────── */

function renderSparkline() {
  const canvas = $("#sparkline-canvas");
  canvas.style.width = "100%";
  drawSparkline(canvas, Array.from(values), {
    color: "rgb(96, 165, 250)",
    fillAlpha: 0.08,
    lineWidth: 2,
  });
}

/* ─── Render: Decision Tree ───────────────────────────────────────── */

function renderDecisionTree() {
  const container = $("#decision-tree");
  const row = selectedRow >= 0 ? rows[selectedRow] : null;
  const enc = row ? row.encoding : null;

  // Determine which nodes/arrows are on the active path
  const isFirst = enc === "first";
  const isIdentical = enc === "identical";
  const isReuse = enc === "reuse";
  const isNew = enc === "new";
  const hasPath = enc && !isFirst;

  function nc(nodeId) {
    if (!hasPath) return "dt-node";
    switch (nodeId) {
      case "xor-q":
        return hasPath ? "dt-node dt-active" : "dt-node dt-dim";
      case "identical":
        return isIdentical ? "dt-node dt-active-green" : "dt-node dt-dim";
      case "window-q":
        return isReuse || isNew ? "dt-node dt-active" : "dt-node dt-dim";
      case "reuse":
        return isReuse ? "dt-node dt-active" : "dt-node dt-dim";
      case "new":
        return isNew ? "dt-node dt-active-yellow" : "dt-node dt-dim";
      default:
        return "dt-node";
    }
  }

  function ac(arrowId) {
    if (!hasPath) return "dt-arrow";
    switch (arrowId) {
      case "xor-yes":
        return isIdentical ? "dt-arrow dt-active" : "dt-arrow dt-dim";
      case "xor-no":
        return isReuse || isNew ? "dt-arrow dt-active" : "dt-arrow dt-dim";
      case "win-yes":
        return isReuse ? "dt-arrow dt-active" : "dt-arrow dt-dim";
      case "win-no":
        return isNew ? "dt-arrow dt-active" : "dt-arrow dt-dim";
      default:
        return "dt-arrow";
    }
  }

  function vc(vertId) {
    if (!hasPath) return "dt-vert";
    switch (vertId) {
      case "v1":
        return isReuse || isNew ? "dt-vert dt-active" : "dt-vert dt-dim";
      case "v2":
        return isNew ? "dt-vert dt-active" : "dt-vert dt-dim";
      default:
        return "dt-vert";
    }
  }

  // Cost annotation for the active leaf
  let costNote = "";
  if (row && hasPath) {
    costNote = ` → ${row.cost} bits`;
  }

  container.innerHTML = `
    <div class="dt-flow">
      <div class="dt-row">
        <div class="${nc("xor-q")}">
          <span class="dt-label"><span class="xp-term" data-term="XOR">XOR</span> = 0 ?</span>
        </div>
        <div class="${ac("xor-yes")}">
          <span class="dt-lbl dt-lbl-yes">yes</span>
          <span class="dt-arrow-line">→</span>
        </div>
        <div class="${nc("identical")}">
          <span class="dt-label">Write "<code>0</code>"</span>
          <span class="dt-cost">1 bit${isIdentical ? costNote : ""}</span>
        </div>
      </div>

      <div class="${vc("v1")}">
        <span>no ↓</span>
      </div>

      <div class="dt-row">
        <div class="${nc("window-q")}">
          <span class="dt-label"><span class="xp-term" data-term="window">Window</span> fits ?</span>
          <span class="dt-cost">lead ≥ prev_lead &amp;&amp; trail ≥ prev_trail</span>
        </div>
        <div class="${ac("win-yes")}">
          <span class="dt-lbl dt-lbl-yes">yes</span>
          <span class="dt-arrow-line">→</span>
        </div>
        <div class="${nc("reuse")}">
          <span class="dt-label">Write "<code>10</code>" + <span class="xp-term" data-term="meaningful bits">meaningful</span></span>
          <span class="dt-cost">2 + M bits${isReuse ? costNote : ""}</span>
        </div>
      </div>

      <div class="${vc("v2")}">
        <span>no ↓</span>
      </div>

      <div class="dt-row">
        <div class="${nc("new")}">
          <span class="dt-label">Write "<code>11</code>" + 6‑bit lead + 6‑bit len + <span class="xp-term" data-term="meaningful bits">meaningful</span></span>
          <span class="dt-cost">14 + M bits${isNew ? costNote : ""}</span>
        </div>
      </div>
    </div>`;
}

/* ─── Mini XOR bits for table cell ────────────────────────────────── */

function buildMiniXorBits(row) {
  const container = el("div", { class: "xor-mini-bits" });
  const { xorBits, leadingZeros: lz, trailingZeros: tz } = row;

  for (let i = 0; i < 64; i++) {
    const bit = xorBits[i];
    let cls = "xor-mini-bit";
    if (i < lz || i >= 64 - tz) {
      cls += " xor-zero";
    } else {
      cls += " xor-meaningful";
    }
    container.appendChild(el("span", { class: cls }, bit));
  }
  return container;
}

/* ─── Build 64-bit grid ───────────────────────────────────────────── */

function buildBitGrid(bits, options = {}) {
  const {
    leadingZeros = 0,
    trailingZeros = 0,
    highlightMeaningful = false,
    windowLeading,
    windowTrailing,
    label = "",
  } = options;

  const wrap = el("div", { class: "xor-bitgrid-wrap" });
  if (label) {
    wrap.appendChild(el("div", { class: "xor-bitgrid-label" }, label));
  }

  const grid = el("div", { class: "xp-bit-grid xor-bitgrid" });
  const hasWindow = windowLeading !== undefined;
  const wl = hasWindow ? windowLeading : leadingZeros;
  const wt = hasWindow ? windowTrailing : trailingZeros;

  for (let i = 0; i < 64; i++) {
    const bit = bits[i];
    let cls = "xp-bit";

    if (highlightMeaningful) {
      const inWindow = i >= wl && i < 64 - wt;
      const isActualMeaningful = i >= leadingZeros && i < 64 - trailingZeros;

      if (isActualMeaningful) {
        cls += " xor-bit-meaningful";
      } else if (inWindow) {
        cls += " xor-bit-window";
      } else {
        cls += " xor-bit-faded";
      }
    }

    const cell = el("div", { class: cls, "data-v": bit });
    cell.textContent = bit;
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  // Position markers
  if (highlightMeaningful && (leadingZeros > 0 || trailingZeros > 0)) {
    const markers = el("div", { class: "xor-bitgrid-markers" });
    if (leadingZeros > 0) {
      markers.appendChild(
        el(
          "span",
          {
            class: "xor-marker",
            style: { left: "0", width: `${(leadingZeros / 64) * 100}%` },
          },
          `${leadingZeros} leading`
        )
      );
    }
    if (trailingZeros > 0) {
      markers.appendChild(
        el(
          "span",
          {
            class: "xor-marker",
            style: { right: "0", width: `${(trailingZeros / 64) * 100}%`, textAlign: "right" },
          },
          `${trailingZeros} trailing`
        )
      );
    }
    wrap.appendChild(markers);
  }

  return wrap;
}

/* ─── Detail Panel — first value ──────────────────────────────────── */

function buildFirstValueDetail(row) {
  const panel = el("div", { class: "xor-detail-panel xp-animate-in" });
  panel.appendChild(el("h3", {}, `Value #${row.idx}: ${row.value} — stored as raw 64 bits`));
  panel.appendChild(buildBitGrid(row.bits, { label: "IEEE 754 bits" }));
  const ieee754Note = el(
    "p",
    { class: "xor-ieee-note" },
    `Each float64 is: 1 sign bit + 11 exponent bits + 52 fraction bits (`,
    el("span", { class: "xp-term", "data-term": "IEEE 754" }, "IEEE 754"),
    `)`
  );
  panel.appendChild(ieee754Note);

  const encSection = el("div", { class: "xor-encoded-section" });
  encSection.appendChild(el("div", { class: "xor-bitgrid-label" }, "Encoded output"));
  const encGrid = el("div", { class: "xor-encoded-bits" });
  for (let i = 0; i < 64; i++) {
    encGrid.appendChild(el("span", { class: "xor-enc-bit enc-raw" }, row.bits[i]));
  }
  encSection.appendChild(encGrid);
  encSection.appendChild(
    el("div", { class: "xor-enc-annotation" }, "64 raw bits — first value stored uncompressed")
  );
  panel.appendChild(encSection);
  return panel;
}

/* ─── Detail Panel — subsequent values ────────────────────────────── */

function buildDetailPanel(row) {
  const panel = el("div", { class: "xor-detail-panel xp-animate-in" });
  const prevRow = rows[row.idx - 1];

  panel.appendChild(el("h3", {}, `Value #${row.idx}: ${row.value}`));

  // Previous & current bit grids
  panel.appendChild(
    buildBitGrid(prevRow.bits, { label: `Previous (#${prevRow.idx}): ${prevRow.value}` })
  );
  panel.appendChild(buildBitGrid(row.bits, { label: `Current (#${row.idx}): ${row.value}` }));

  // XOR result with meaningful highlighting
  if (row.encoding === "identical") {
    panel.appendChild(
      buildBitGrid(row.xorBits, {
        label: "XOR result — all zeros (identical)",
        leadingZeros: 64,
        trailingZeros: 0,
        highlightMeaningful: true,
      })
    );
  } else {
    panel.appendChild(
      buildBitGrid(row.xorBits, {
        label: "XOR result",
        leadingZeros: row.leadingZeros,
        trailingZeros: row.trailingZeros,
        highlightMeaningful: true,
        windowLeading: row.windowLeading,
        windowTrailing: row.windowTrailing,
      })
    );
  }

  // Encoded bits with colored annotations
  const encSection = el("div", { class: "xor-encoded-section" });
  encSection.appendChild(el("div", { class: "xor-bitgrid-label" }, "Encoded output"));

  const encGrid = el("div", { class: "xor-encoded-bits" });

  if (row.encoding === "identical") {
    encGrid.appendChild(el("span", { class: "xor-enc-bit enc-ctrl" }, "0"));
    encSection.appendChild(encGrid);
    const ann = el("div", { class: "xor-enc-annotation" });
    ann.innerHTML = `"0" → values are identical. Total: 1 bit.`;
    encSection.appendChild(ann);
  } else if (row.encoding === "reuse") {
    // Control: "10"
    encGrid.appendChild(el("span", { class: "xor-enc-bit enc-ctrl" }, "1"));
    encGrid.appendChild(el("span", { class: "xor-enc-bit enc-ctrl" }, "0"));

    // Data: meaningful bits within previous window
    const wl = row.windowLeading;
    const wt = row.windowTrailing;
    for (let i = wl; i < 64 - wt; i++) {
      encGrid.appendChild(el("span", { class: "xor-enc-bit enc-data" }, row.xorBits[i]));
    }
    encSection.appendChild(encGrid);
    const ann = el("div", { class: "xor-enc-annotation" });
    ann.innerHTML =
      `"1" (not identical) + "0" (reuse <span class="xp-term" data-term="window">window</span>) + ` +
      `${row.windowMeaningful} bits in <span class="xp-term" data-term="window">window</span> [${wl}…${63 - wt}] = ${row.cost} bits total`;
    encSection.appendChild(ann);

    // Legend
    const legend = el("div", { class: "xor-enc-legend" });
    legend.appendChild(makeLegendItem("rgba(248, 113, 113, 0.3)", "Control bits"));
    legend.appendChild(makeLegendItem("rgba(96, 165, 250, 0.3)", "Data (within prev window)"));
    encSection.appendChild(legend);
  } else if (row.encoding === "new") {
    // Control: "11"
    encGrid.appendChild(el("span", { class: "xor-enc-bit enc-ctrl" }, "1"));
    encGrid.appendChild(el("span", { class: "xor-enc-bit enc-ctrl" }, "1"));

    // 6-bit leading zero count
    const lzBin = row.leadingZeros.toString(2).padStart(6, "0");
    for (const b of lzBin) {
      encGrid.appendChild(el("span", { class: "xor-enc-bit enc-meta" }, b));
    }

    // 6-bit meaningful length
    const mlBin = row.meaningfulBits.toString(2).padStart(6, "0");
    for (const b of mlBin) {
      encGrid.appendChild(el("span", { class: "xor-enc-bit enc-meta2" }, b));
    }

    // Meaningful data bits
    const lz = row.leadingZeros;
    const tz = row.trailingZeros;
    for (let i = lz; i < 64 - tz; i++) {
      encGrid.appendChild(el("span", { class: "xor-enc-bit enc-data" }, row.xorBits[i]));
    }
    encSection.appendChild(encGrid);
    const ann = el("div", { class: "xor-enc-annotation" });
    ann.innerHTML =
      `"11" (new <span class="xp-term" data-term="window">window</span>) + ` +
      `${lzBin} (<span class="xp-term" data-term="leading zeros">leading</span>=${row.leadingZeros}) + ` +
      `${mlBin} (<span class="xp-term" data-term="meaningful bits">meaningful</span>=${row.meaningfulBits}) + ` +
      `${row.meaningfulBits} data bits = ${row.cost} bits total`;
    encSection.appendChild(ann);

    // Legend
    const legend = el("div", { class: "xor-enc-legend" });
    legend.appendChild(makeLegendItem("rgba(248, 113, 113, 0.3)", "Control"));
    legend.appendChild(makeLegendItem("rgba(139, 92, 246, 0.3)", "Leading zeros (6 bits)"));
    legend.appendChild(makeLegendItem("rgba(6, 182, 212, 0.3)", "Meaningful len (6 bits)"));
    legend.appendChild(makeLegendItem("rgba(96, 165, 250, 0.3)", "Data bits"));
    encSection.appendChild(legend);
  }

  panel.appendChild(encSection);
  return panel;
}

function makeLegendItem(bg, text) {
  return el(
    "div",
    { class: "xor-enc-legend-item" },
    el("span", { class: "xor-enc-legend-swatch", style: { background: bg } }),
    el("span", {}, text)
  );
}

/* ─── Render: XOR Table ───────────────────────────────────────────── */

function renderTable() {
  const tbody = $("#xor-tbody");
  tbody.innerHTML = "";

  for (const row of rows) {
    const tr = el("tr", {
      class: `xor-row xor-enc-${row.encoding}${selectedRow === row.idx ? " xor-selected" : ""}`,
      onClick: () => {
        selectedRow = selectedRow === row.idx ? -1 : row.idx;
        renderTable();
        renderDecisionTree();
      },
    });

    // #
    tr.appendChild(el("td", { class: "xor-idx" }, String(row.idx)));

    // Value
    tr.appendChild(
      el(
        "td",
        { class: "xor-val" },
        Number.isInteger(row.value) ? String(row.value) : row.value.toFixed(4)
      )
    );

    // XOR bits (compact in table)
    if (row.xorBits === null) {
      tr.appendChild(el("td", { class: "xor-na" }, "— first value"));
    } else if (row.xorUint64 === 0n) {
      tr.appendChild(
        el("td", { class: "xor-na", style: { color: "var(--tier-0)" } }, "= 0 (identical)")
      );
    } else {
      const cell = el("td", { class: "xor-bits-cell" });
      cell.appendChild(buildMiniXorBits(row));
      tr.appendChild(cell);
    }

    // Leading zeros
    tr.appendChild(
      el("td", { class: "xor-num" }, row.leadingZeros !== null ? String(row.leadingZeros) : "—")
    );

    // Trailing zeros
    tr.appendChild(
      el("td", { class: "xor-num" }, row.trailingZeros !== null ? String(row.trailingZeros) : "—")
    );

    // Meaningful bits
    tr.appendChild(
      el("td", { class: "xor-num" }, row.meaningfulBits !== null ? String(row.meaningfulBits) : "—")
    );

    // Encoding badge
    const badge = el(
      "span",
      { class: `xp-badge xor-enc-badge enc-${row.encoding}` },
      ENC_LABELS[row.encoding]
    );
    tr.appendChild(el("td", {}, badge));

    // Cost
    const costTd = el("td", { class: "xor-cost" }, `${row.cost}b`);
    costTd.style.color = ENC_COLORS[row.encoding];
    tr.appendChild(costTd);

    tbody.appendChild(tr);

    // Expanded detail panel on click
    if (selectedRow === row.idx) {
      const detailTr = el("tr", { class: "xor-detail-row" });
      const detailTd = el("td", { colspan: "8" });
      detailTd.appendChild(
        row.encoding === "first" ? buildFirstValueDetail(row) : buildDetailPanel(row)
      );
      detailTr.appendChild(detailTd);
      tbody.appendChild(detailTr);
    }
  }
}

/* ─── Render: Cost Profile (Canvas) ───────────────────────────────── */

function renderCostProfile() {
  const canvas = $("#cost-canvas");
  canvas.style.width = "100%";

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const n = rows.length;
  if (n === 0) return;

  const maxCost = 64;
  const pad = { top: 24, bottom: 28, left: 36, right: 12 };
  const available = w - pad.left - pad.right;
  const barW = Math.max(6, Math.min(28, available / n - 4));
  const gap = (available - barW * n) / (n + 1);
  const chartH = h - pad.top - pad.bottom;

  // Y axis grid
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const yVal of [0, 16, 32, 48, 64]) {
    const y = pad.top + chartH * (1 - yVal / maxCost);
    ctx.fillStyle = "#4b5563";
    ctx.font = `10px "IBM Plex Mono", monospace`;
    ctx.fillText(`${yVal}`, pad.left - 8, y);
    ctx.strokeStyle = "rgba(96, 165, 250, 0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  // Bars
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const x = pad.left + gap + i * (barW + gap);
    const barH = Math.max(2, (row.cost / maxCost) * chartH);
    const y = pad.top + chartH - barH;

    // Bar fill
    ctx.fillStyle = ENC_COLORS[row.encoding];
    const r = Math.min(3, barW / 2);
    ctx.beginPath();
    ctx.moveTo(x, y + r);
    ctx.arcTo(x, y, x + barW, y, r);
    ctx.arcTo(x + barW, y, x + barW, y + barH, r);
    ctx.lineTo(x + barW, pad.top + chartH);
    ctx.lineTo(x, pad.top + chartH);
    ctx.closePath();
    ctx.fill();

    // Highlight selected
    if (selectedRow === i) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Cost label
    ctx.fillStyle = "#94a3b8";
    ctx.font = `9px "IBM Plex Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${row.cost}`, x + barW / 2, y - 3);

    // X label
    ctx.fillStyle = "#4b5563";
    ctx.textBaseline = "top";
    ctx.fillText(`${i}`, x + barW / 2, pad.top + chartH + 6);
  }
}

/* ─── Render: Summary Stats ───────────────────────────────────────── */

function renderSummary() {
  const statsRow = $("#summary-stats");
  statsRow.innerHTML = "";

  const rawBits = rows.length * 64;
  const compressedBits = rows.reduce((sum, r) => sum + r.cost, 0);
  const rawBytes = rawBits / 8;
  const compressedBytes = Math.ceil(compressedBits / 8);
  const ratio = rawBytes / compressedBytes;
  const avgBits = compressedBits / rows.length;

  const encoded = rows.length - 1;
  const identicalCount = rows.filter((r) => r.encoding === "identical").length;
  const reuseCount = rows.filter((r) => r.encoding === "reuse").length;
  const newCount = rows.filter((r) => r.encoding === "new").length;

  const stats = [
    { label: "Raw Size", value: fmtBytes(rawBytes), unit: `${rows.length} × 8 B` },
    { label: "Compressed", value: fmtBytes(compressedBytes), unit: `${fmt(compressedBits)} bits` },
    { label: "Ratio", value: `${ratio.toFixed(1)}×`, unit: "smaller" },
    { label: "Avg bits/val", value: avgBits.toFixed(1), unit: "bits" },
  ];

  for (const s of stats) {
    const stat = buildStat(s.label, s.value, s.unit);
    if (s.label === "Ratio") {
      const valEl = stat.querySelector(".xp-stat-value");
      valEl.style.color =
        ratio >= 10 ? "var(--xp-success)" : ratio >= 4 ? "var(--xp-accent)" : "var(--xp-warn)";
    }
    statsRow.appendChild(stat);
  }

  // Encoding distribution bar
  const barEl = $("#encoding-bar");
  barEl.innerHTML = "";

  const segments = [
    { label: "Identical", count: identicalCount, color: ENC_COLORS.identical },
    { label: "Reuse", count: reuseCount, color: ENC_COLORS.reuse },
    { label: "New Window", count: newCount, color: ENC_COLORS.new },
  ];

  const barContainer = el("div", { class: "xor-dist-bar" });
  for (const seg of segments) {
    if (seg.count === 0) continue;
    const pct = (seg.count / encoded) * 100;
    const segDiv = el(
      "div",
      {
        class: "xor-dist-seg",
        style: { flexBasis: `${pct}%`, background: seg.color },
      },
      pct >= 14 ? `${seg.count} ${seg.label}` : `${seg.count}`
    );
    barContainer.appendChild(segDiv);
  }
  barEl.appendChild(barContainer);

  // Legend
  const legend = el("div", { class: "xor-dist-legend" });
  for (const seg of segments) {
    legend.appendChild(
      el(
        "div",
        { class: "xor-dist-legend-item" },
        el("span", { class: "xor-dist-dot", style: { background: seg.color } }),
        el(
          "span",
          {},
          `${seg.label}: ${seg.count} (${encoded > 0 ? Math.round((seg.count / encoded) * 100) : 0}%)`
        )
      )
    );
  }
  barEl.appendChild(legend);

  // Narrative story
  const story = $("#compression-story");
  const patternName = PATTERNS.find((p) => p.id === activePattern)?.label ?? activePattern;
  const identPct = encoded > 0 ? Math.round((identicalCount / encoded) * 100) : 0;
  const reusePct = encoded > 0 ? Math.round((reuseCount / encoded) * 100) : 0;

  if (ratio >= 10) {
    story.innerHTML =
      `<strong>${patternName}</strong> achieves <strong class="success">${ratio.toFixed(1)}× compression</strong>. ` +
      `${identPct}% of values are identical to their predecessor (1 bit each), ` +
      `${reusePct}% reuse the previous bit <span class="xp-term" data-term="window">window</span>. ` +
      `Average cost: just <strong class="success">${avgBits.toFixed(1)} bits/value</strong> vs 64 bits raw.`;
  } else if (ratio >= 3) {
    story.innerHTML =
      `<strong>${patternName}</strong> compresses to <strong>${ratio.toFixed(1)}×</strong>. ` +
      `${identPct}% identical, ${reusePct}% <span class="xp-term" data-term="window">window</span> reuse. ` +
      `The changing values still share many bits, averaging <strong>${avgBits.toFixed(1)} bits/value</strong>.`;
  } else {
    story.innerHTML =
      `<strong>${patternName}</strong> compresses poorly at <strong class="warn">${ratio.toFixed(1)}×</strong>. ` +
      `Random values share few bits, so <span class="xp-term" data-term="XOR">XOR</span> results have many <span class="xp-term" data-term="meaningful bits">meaningful bits</span>. ` +
      `Average cost: <strong class="warn">${avgBits.toFixed(1)} bits/value</strong> — close to raw.`;
  }
}

/* ─── Recompute & Render All ──────────────────────────────────────── */

function recompute() {
  values = generateValues(activePattern, SAMPLE_COUNT);
  rows = computeRows(values);

  updatePatternButtons();
  renderSparkline();
  renderDecisionTree();
  renderTable();
  renderCostProfile();
  renderSummary();
}

/* ─── Init ────────────────────────────────────────────────────────── */

function init() {
  $("#breadcrumb-nav").innerHTML = buildBreadcrumb("XOR\u2011Delta");
  renderPatternPicker();
  recompute();
  initGlossary();

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderSparkline();
      renderCostProfile();
    }, 150);
  });
}

document.addEventListener("DOMContentLoaded", init);
