/**
 * String Interning — Interactive Experience
 * Demonstrates how TSDB engines store label strings once and reference them by ID.
 */
import { $, $$, buildBreadcrumb, buildStat, el, fmt, fmtBytes, Stepper } from "../shared.js";

/* ─── Constants ──────────────────────────────────────────────────── */

const LABEL_DEFS = {
  __name__: [
    "http_requests_total",
    "cpu_usage_percent",
    "memory_bytes",
    "disk_io_bytes",
    "gc_pause_seconds",
  ],
  region: ["us-east-1", "us-west-2", "eu-west-1", "ap-south-1"],
  job: ["api-server", "web-frontend", "worker", "scheduler"],
  instance: Array.from({ length: 10 }, (_, i) => `pod-${String(i + 1).padStart(3, "0")}`),
};

const HASH_TABLE_SIZE = 64;

const STRING_COLORS = [
  "#34d399",
  "#60a5fa",
  "#a78bfa",
  "#fbbf24",
  "#f87171",
  "#2dd4bf",
  "#f472b6",
  "#fb923c",
  "#818cf8",
  "#4ade80",
  "#38bdf8",
  "#e879f9",
];

/* ─── FNV-1a Hash ────────────────────────────────────────────────── */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/* ─── String Interning Engine ────────────────────────────────────── */

class StringInterner {
  constructor(tableSize = HASH_TABLE_SIZE) {
    this.tableSize = tableSize;
    this.table = new Array(tableSize).fill(null); // { id, str }
    this.strings = []; // ordered unique strings
    this.buffer = []; // byte buffer segments: { str, offset, len }
    this.nextId = 0;
    this.bufferOffset = 0;
    this.colorMap = new Map();
  }

  intern(str) {
    const hash = fnv1a(str);
    let idx = hash % this.tableSize;
    const probeSteps = [];

    for (let i = 0; i < this.tableSize; i++) {
      const slot = this.table[idx];
      if (slot === null) {
        const id = this.nextId++;
        const byteLen = new TextEncoder().encode(str).length;
        this.table[idx] = { id, str };
        this.strings.push(str);
        this.buffer.push({ str, offset: this.bufferOffset, len: byteLen });
        this.bufferOffset += byteLen;
        this.colorMap.set(str, STRING_COLORS[id % STRING_COLORS.length]);
        return {
          id,
          isNew: true,
          hash,
          bucketIdx: hash % this.tableSize,
          probeSteps,
          finalIdx: idx,
        };
      }
      if (slot.str === str) {
        return {
          id: slot.id,
          isNew: false,
          hash,
          bucketIdx: hash % this.tableSize,
          probeSteps,
          finalIdx: idx,
        };
      }
      probeSteps.push(idx);
      idx = (idx + 1) % this.tableSize;
    }
    throw new Error("Hash table full");
  }

  getColor(str) {
    return this.colorMap.get(str) || "#64748b";
  }

  getId(str) {
    for (const entry of this.table) {
      if (entry && entry.str === str) return entry.id;
    }
    return -1;
  }
}

/* ─── State ──────────────────────────────────────────────────────── */

let series = [];
let interner = new StringInterner();
let animInterner = new StringInterner();
let stepper = null;

/* ─── Series Generation ──────────────────────────────────────────── */

function generateSeries(count) {
  const keys = Object.keys(LABEL_DEFS);
  const result = [];
  for (let i = 0; i < count; i++) {
    const labels = {};
    for (const k of keys) {
      const pool = LABEL_DEFS[k];
      labels[k] = pool[Math.floor(Math.random() * pool.length)];
    }
    result.push(labels);
  }
  return result;
}

function labelStrings(labels) {
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`);
}

/* ─── Stats Calculation ──────────────────────────────────────────── */

function computeStats(seriesList) {
  interner = new StringInterner();
  let totalRefs = 0;
  const allLabels = [];

  for (const s of seriesList) {
    const strs = labelStrings(s);
    for (const str of strs) {
      interner.intern(str);
      totalRefs++;
    }
    allLabels.push(strs);
  }

  const avgLen =
    interner.buffer.reduce((s, b) => s + b.len, 0) / Math.max(interner.strings.length, 1);
  const _naiveBytes =
    totalRefs *
    Math.round(
      avgLen > 0 ? interner.buffer.reduce((s, b) => s + b.len, 0) / interner.strings.length : 15
    );

  let naiveTotal = 0;
  for (const strs of allLabels) {
    for (const str of strs) {
      naiveTotal += new TextEncoder().encode(str).length;
    }
  }

  const internedBufferBytes = interner.bufferOffset;
  const internedIdBytes = totalRefs * 4;
  const internedTotal = internedBufferBytes + internedIdBytes;

  return {
    totalSeries: seriesList.length,
    uniqueStrings: interner.strings.length,
    totalRefs,
    naiveBytes: naiveTotal,
    internedBytes: internedTotal,
    internedBufferBytes,
    internedIdBytes,
    ratio: naiveTotal / Math.max(internedTotal, 1),
    allLabels,
  };
}

/* ─── Render: Stats Row ──────────────────────────────────────────── */

function renderStats(stats) {
  const row = $("#stats-row");
  row.innerHTML = "";
  const items = [
    ["Total Series", fmt(stats.totalSeries), ""],
    ["Unique Strings", fmt(stats.uniqueStrings), ""],
    ["Total Refs", fmt(stats.totalRefs), ""],
    ["Naive Memory", fmtBytes(stats.naiveBytes), ""],
    ["Interned Memory", fmtBytes(stats.internedBytes), ""],
    ["Savings", `${stats.ratio.toFixed(1)}×`, ""],
  ];
  for (const [label, value, unit] of items) {
    row.appendChild(buildStat(label, value, unit));
  }
}

/* ─── Render: Generator Summary ──────────────────────────────────── */

function renderGenSummary(stats) {
  $("#gen-summary").textContent =
    `${fmt(stats.totalSeries)} series × ${Object.keys(LABEL_DEFS).length} labels = ${fmt(stats.totalRefs)} label references`;
}

/* ─── Render: Naive Panel ────────────────────────────────────────── */

function renderNaivePanel(stats) {
  const body = $("#naive-body");
  body.innerHTML = "";
  const max = Math.min(stats.allLabels.length, 60);

  for (let i = 0; i < max; i++) {
    const row = el("div", { class: "intern-naive-row" });
    for (const str of stats.allLabels[i]) {
      const color = interner.getColor(str);
      const block = el("span", { class: "intern-str-block" }, str);
      block.style.background = color;
      const byteLen = new TextEncoder().encode(str).length;
      block.style.minWidth = `${Math.max(byteLen * 3.5, 40)}px`;
      row.appendChild(block);
    }
    body.appendChild(row);
  }
  if (stats.allLabels.length > max) {
    body.appendChild(
      el(
        "div",
        { style: { color: "var(--xp-text-dim)", fontSize: "11px", padding: "4px 0" } },
        `… and ${fmt(stats.allLabels.length - max)} more series`
      )
    );
  }

  $("#naive-footer").innerHTML =
    `Total: <span style="color:var(--xp-error)">${fmtBytes(stats.naiveBytes)}</span>`;
}

/* ─── Render: Interned Panel ─────────────────────────────────────── */

function renderInternedPanel(stats) {
  // String buffer tape
  const tape = $("#string-buffer-tape");
  tape.innerHTML = "";
  for (const entry of interner.buffer) {
    const seg = el(
      "span",
      {
        class: "intern-tape-seg",
        title: `ID ${interner.getId(entry.str)} | offset ${entry.offset} | ${entry.len} bytes`,
      },
      entry.str
    );
    seg.style.background = interner.getColor(entry.str);
    tape.appendChild(seg);
  }

  // ID table
  const table = $("#id-table");
  table.innerHTML = "";
  for (const entry of interner.buffer) {
    const id = interner.getId(entry.str);
    const color = interner.getColor(entry.str);
    const badge = el("span", { class: "id-badge" }, `${id}`);
    badge.style.background = color;
    const row = el(
      "div",
      { class: "intern-id-entry" },
      badge,
      el("span", {}, truncStr(entry.str, 18)),
      el("span", { class: "id-meta" }, `@${entry.offset}+${entry.len}`)
    );
    table.appendChild(row);
  }

  // References
  const body = $("#interned-body");
  body.innerHTML = "";
  const max = Math.min(stats.allLabels.length, 60);

  for (let i = 0; i < max; i++) {
    const row = el("div", { class: "intern-ref-row" });
    for (const str of stats.allLabels[i]) {
      const id = interner.getId(str);
      const color = interner.getColor(str);
      const chip = el("span", { class: "intern-ref-chip", title: str }, `${id}`);
      chip.style.background = color;
      row.appendChild(chip);
    }
    body.appendChild(row);
  }
  if (stats.allLabels.length > max) {
    body.appendChild(
      el(
        "div",
        { style: { color: "var(--xp-text-dim)", fontSize: "11px", padding: "4px 0" } },
        `… and ${fmt(stats.allLabels.length - max)} more series`
      )
    );
  }

  $("#interned-footer").innerHTML =
    `Total: <span style="color:var(--xp-success)">${fmtBytes(stats.internedBytes)}</span> ` +
    `<span style="font-size:11px;color:var(--xp-text-dim)">(buffer ${fmtBytes(stats.internedBufferBytes)} + IDs ${fmtBytes(stats.internedIdBytes)})</span>`;
}

/* ─── Render: Memory Bars ────────────────────────────────────────── */

function renderMemoryBars(stats) {
  const wrap = $("#memory-bars");
  wrap.innerHTML = "";
  const container = el("div", { class: "intern-mem-bar-row" });

  // Naive bar
  const naiveBar = el("div", { class: "intern-mem-bar" });
  naiveBar.innerHTML = `
    <div class="intern-mem-bar-label">
      <span>Naive Storage</span>
      <span class="bytes">${fmtBytes(stats.naiveBytes)}</span>
    </div>
    <div class="intern-mem-bar-track">
      <div class="intern-mem-bar-fill naive" id="naive-bar-fill" style="width:0%">
        ${fmtBytes(stats.naiveBytes)}
      </div>
    </div>`;
  container.appendChild(naiveBar);

  // Interned bar
  const internedBar = el("div", { class: "intern-mem-bar" });
  const pct = Math.max(2, (stats.internedBytes / stats.naiveBytes) * 100);
  internedBar.innerHTML = `
    <div class="intern-mem-bar-label">
      <span>Interned Storage</span>
      <span class="bytes">${fmtBytes(stats.internedBytes)}</span>
    </div>
    <div class="intern-mem-bar-track">
      <div class="intern-mem-bar-fill interned" id="interned-bar-fill" style="width:0%">
        ${fmtBytes(stats.internedBytes)}
      </div>
    </div>`;
  container.appendChild(internedBar);

  const badge = el(
    "div",
    { class: "intern-savings-badge" },
    `🎯 ${stats.ratio.toFixed(1)}× smaller with interning`
  );
  container.appendChild(badge);

  wrap.appendChild(container);

  // Animate bars
  requestAnimationFrame(() => {
    $("#naive-bar-fill").style.width = "100%";
    $("#interned-bar-fill").style.width = `${pct.toFixed(1)}%`;
  });
}

/* ─── Render: Intern Animation ───────────────────────────────────── */

function setupAnimation() {
  const select = $("#anim-string-select");
  select.innerHTML = "";

  // Collect some sample strings
  const samples = [];
  for (const [k, vals] of Object.entries(LABEL_DEFS)) {
    for (const v of vals.slice(0, 3)) {
      samples.push(`${k}=${v}`);
    }
  }
  for (const s of samples) {
    select.appendChild(el("option", { value: s }, s));
  }

  setupAnimPipeline();
  setupHashGrid();
  resetAnimation();
}

function setupAnimPipeline() {
  const pipeline = $("#anim-pipeline");
  pipeline.innerHTML = "";
  const stages = [
    ["📝", "Input"],
    ["#️⃣", "Hash"],
    ["🎯", "Bucket"],
    ["🔍", "Probe"],
    ["💾", "Result"],
  ];
  stages.forEach(([icon, label], i) => {
    if (i > 0) pipeline.appendChild(el("span", { class: "xp-pipe-arrow" }, "→"));
    const stage = el(
      "div",
      {
        class: "xp-pipe-stage",
        "data-stage": `${i}`,
      },
      el("span", { class: "stage-icon" }, icon),
      el("span", { class: "stage-label" }, label)
    );
    pipeline.appendChild(stage);
  });
}

function setupHashGrid() {
  const grid = $("#hash-grid");
  grid.innerHTML = "";
  animInterner = new StringInterner();
  for (let i = 0; i < HASH_TABLE_SIZE; i++) {
    const cell = el(
      "div",
      {
        class: "intern-hash-cell",
        "data-idx": `${i}`,
      },
      `${i}`
    );
    grid.appendChild(cell);
  }
}

function resetAnimation() {
  const detail = $("#anim-detail");
  detail.innerHTML =
    '<span style="color:var(--xp-text-dim)">Select a string and click <strong>Next →</strong> to begin the interning pipeline.</span>';
  $$(".xp-pipe-stage", $("#anim-pipeline")).forEach((s) => {
    s.classList.remove("active");
  });
  clearHashGridHighlights();
  if (stepper) stepper.stop();
}

function clearHashGridHighlights() {
  $$(".intern-hash-cell", $("#hash-grid")).forEach((c) => {
    c.classList.remove("probe-target", "probe-collision", "probe-found");
  });
}

function runInternAnimation() {
  const str = $("#anim-string-select").value;
  if (!str) return;

  const hash = fnv1a(str);
  const bucketIdx = hash % HASH_TABLE_SIZE;

  // Pre-compute what will happen
  const probeSteps = [];
  let finalIdx = bucketIdx;
  let isNew = true;
  let _existingId = -1;

  // Simulate probing
  for (let i = 0; i < HASH_TABLE_SIZE; i++) {
    const idx = (bucketIdx + i) % HASH_TABLE_SIZE;
    const slot = animInterner.table[idx];
    if (slot === null) {
      finalIdx = idx;
      isNew = true;
      break;
    }
    if (slot.str === str) {
      finalIdx = idx;
      isNew = false;
      _existingId = slot.id;
      break;
    }
    probeSteps.push(idx);
  }

  const totalSteps = probeSteps.length > 0 ? 5 : isNew ? 5 : 5;

  if (stepper) stepper.stop();

  stepper = new Stepper(totalSteps, (step) => {
    const detail = $("#anim-detail");
    const pipeline = $$(".xp-pipe-stage", $("#anim-pipeline"));
    pipeline.forEach((s, i) => {
      s.classList.toggle("active", i <= step);
    });
    clearHashGridHighlights();

    switch (step) {
      case 0: {
        // Step 0: Show input string as character grid
        const bytes = new TextEncoder().encode(str);
        let charHtml = '<div class="anim-label">Input String</div>';
        charHtml += `<div><span class="anim-value">"${str}"</span> — ${bytes.length} UTF-8 bytes</div>`;
        charHtml += '<div class="intern-char-grid">';
        for (let i = 0; i < str.length; i++) {
          charHtml += `<span class="intern-char-cell">${escHtml(str[i])}</span>`;
        }
        charHtml += "</div>";
        detail.innerHTML = charHtml;
        break;
      }
      case 1: {
        // Step 1: Compute FNV-1a hash
        let html = '<div class="anim-label">FNV-1a Hash</div>';
        html += '<div class="intern-char-grid">';
        for (let i = 0; i < str.length; i++) {
          html += `<span class="intern-char-cell active">${escHtml(str[i])}</span>`;
        }
        html += "</div>";
        html += `<div style="margin-top:8px">hash = <span class="anim-value">0x${hash.toString(16).padStart(8, "0")}</span>`;
        html += ` (${fmt(hash)})</div>`;
        html +=
          '<div style="margin-top:4px;font-size:11px;color:var(--xp-text-dim)">XOR each byte → multiply by FNV prime 0x01000193</div>';
        detail.innerHTML = html;
        break;
      }
      case 2: {
        // Step 2: Bucket index
        let html = '<div class="anim-label">Bucket Index</div>';
        html += `<div>hash % ${HASH_TABLE_SIZE} = <span class="anim-value">0x${hash.toString(16).padStart(8, "0")}</span> % ${HASH_TABLE_SIZE} = <span class="anim-highlight">${bucketIdx}</span></div>`;
        detail.innerHTML = html;
        // Highlight bucket in grid
        const cell = $(`.intern-hash-cell[data-idx="${bucketIdx}"]`, $("#hash-grid"));
        if (cell) cell.classList.add("probe-target");
        break;
      }
      case 3: {
        // Step 3: Probe
        let html = '<div class="anim-label">Linear Probe</div>';
        if (probeSteps.length === 0 && isNew) {
          html += `<div>Bucket <span class="anim-highlight">${bucketIdx}</span> is <span class="anim-highlight">empty</span> — no collision!</div>`;
          const cell = $(`.intern-hash-cell[data-idx="${bucketIdx}"]`, $("#hash-grid"));
          if (cell) cell.classList.add("probe-target");
        } else if (!isNew) {
          if (probeSteps.length === 0) {
            html += `<div>Bucket <span class="anim-highlight">${bucketIdx}</span> contains <span class="anim-value">"${str}"</span> — <span class="anim-highlight">match found!</span></div>`;
          } else {
            html += `<div>Probed ${probeSteps.length} slot(s) before finding existing <span class="anim-value">"${str}"</span></div>`;
            html += `<div style="margin-top:4px;font-size:11px">Probe path: ${probeSteps.map((i) => `<span class="anim-warn">${i}</span>`).join(" → ")} → <span class="anim-highlight">${finalIdx}</span></div>`;
          }
          for (const idx of probeSteps) {
            const cell = $(`.intern-hash-cell[data-idx="${idx}"]`, $("#hash-grid"));
            if (cell) cell.classList.add("probe-collision");
          }
          const cell = $(`.intern-hash-cell[data-idx="${finalIdx}"]`, $("#hash-grid"));
          if (cell) cell.classList.add("probe-found");
        } else {
          html += `<div>Collision! Probed ${probeSteps.length} occupied slot(s):</div>`;
          html += `<div style="margin-top:4px;font-size:11px">Probe path: ${probeSteps.map((i) => `<span class="anim-warn">${i}</span>`).join(" → ")} → <span class="anim-highlight">${finalIdx}</span> (empty)</div>`;
          for (const idx of probeSteps) {
            const cell = $(`.intern-hash-cell[data-idx="${idx}"]`, $("#hash-grid"));
            if (cell) cell.classList.add("probe-collision");
          }
          const cell = $(`.intern-hash-cell[data-idx="${finalIdx}"]`, $("#hash-grid"));
          if (cell) cell.classList.add("probe-target");
        }
        detail.innerHTML = html;
        break;
      }
      case 4: {
        // Step 4: Result — actually perform the intern
        const result = animInterner.intern(str);
        let _html = '<div class="anim-label">Result</div>';
        if (result.isNew) {
          _html += `<div><span class="anim-highlight">NEW</span> — stored in buffer, assigned ID <span class="anim-value">${result.id}</span></div>`;
          _html += `<div style="margin-top:4px;font-size:12px">Buffer offset: ${animInterner.buffer[result.id].offset}, length: ${animInterner.buffer[result.id].len} bytes</div>`;
        } else {
          _html += `<div><span class="anim-value">REUSE</span> — already interned as ID <span class="anim-value">${result.id}</span></div>`;
          _html += `<div style="margin-top:4px;font-size:12px;color:var(--xp-success)">Zero new storage needed — just return the existing 4-byte ID</div>`;
        }
        // Update hash grid to show occupied cells
        updateHashGridDisplay();
        break;
      }
    }
  });

  stepper.next();
}

function updateHashGridDisplay() {
  const grid = $("#hash-grid");
  for (let i = 0; i < HASH_TABLE_SIZE; i++) {
    const cell = $(`.intern-hash-cell[data-idx="${i}"]`, grid);
    const slot = animInterner.table[i];
    if (slot) {
      cell.classList.add("occupied");
      cell.style.background = animInterner.getColor(slot.str);
      cell.style.borderColor = animInterner.getColor(slot.str);
      cell.textContent = `${slot.id}`;
      cell.title = `ID ${slot.id}: ${slot.str}`;
    }
  }
}

/* ─── Render: Cardinality Chart ──────────────────────────────────── */

function renderCardinalityChart() {
  const canvas = $("#cardinality-canvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const totalRefs = 40000;
  const avgLen = 15;
  const uniqueCounts = [10, 25, 50, 100, 200, 500, 1000];

  const naivePoints = uniqueCounts.map(() => totalRefs * avgLen);
  const internedPoints = uniqueCounts.map((u) => u * avgLen + totalRefs * 4);

  const maxVal = Math.max(...naivePoints, ...internedPoints);
  const padL = 70,
    padR = 20,
    padT = 20,
    padB = 40;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // Grid lines
  ctx.strokeStyle = "rgba(96, 165, 250, 0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  // Y-axis labels
  ctx.font = "10px IBM Plex Mono, monospace";
  ctx.fillStyle = "#64748b";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH / 4) * i;
    const val = maxVal - (maxVal / 4) * i;
    ctx.fillText(formatKB(val), padL - 8, y + 3);
  }

  // X-axis labels
  ctx.textAlign = "center";
  uniqueCounts.forEach((u, i) => {
    const x = padL + (i / (uniqueCounts.length - 1)) * plotW;
    ctx.fillText(`${u}`, x, h - padB + 18);
  });

  // X-axis title
  ctx.fillStyle = "#94a3b8";
  ctx.font = "11px Space Grotesk, sans-serif";
  ctx.fillText("Unique Strings", padL + plotW / 2, h - 4);

  // Draw naive line (flat — always the same)
  ctx.beginPath();
  ctx.strokeStyle = "#f87171";
  ctx.lineWidth = 2;
  uniqueCounts.forEach((_, i) => {
    const x = padL + (i / (uniqueCounts.length - 1)) * plotW;
    const y = padT + plotH * (1 - naivePoints[i] / maxVal);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Naive fill
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.lineTo(padL, padT + plotH);
  ctx.closePath();
  ctx.fillStyle = "rgba(248, 113, 113, 0.06)";
  ctx.fill();

  // Draw interned line
  ctx.beginPath();
  ctx.strokeStyle = "#34d399";
  ctx.lineWidth = 2;
  uniqueCounts.forEach((_, i) => {
    const x = padL + (i / (uniqueCounts.length - 1)) * plotW;
    const y = padT + plotH * (1 - internedPoints[i] / maxVal);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Interned fill
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.lineTo(padL, padT + plotH);
  ctx.closePath();
  ctx.fillStyle = "rgba(52, 211, 153, 0.06)";
  ctx.fill();

  // Draw data points
  uniqueCounts.forEach((_, i) => {
    const x = padL + (i / (uniqueCounts.length - 1)) * plotW;
    // Naive dot
    const ny = padT + plotH * (1 - naivePoints[i] / maxVal);
    ctx.beginPath();
    ctx.arc(x, ny, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#f87171";
    ctx.fill();

    // Interned dot
    const iy = padT + plotH * (1 - internedPoints[i] / maxVal);
    ctx.beginPath();
    ctx.arc(x, iy, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#34d399";
    ctx.fill();
  });

  // Draw savings annotations at a few points
  [1, 3, 5].forEach((i) => {
    const x = padL + (i / (uniqueCounts.length - 1)) * plotW;
    const ny = padT + plotH * (1 - naivePoints[i] / maxVal);
    const iy = padT + plotH * (1 - internedPoints[i] / maxVal);
    const ratio = (naivePoints[i] / internedPoints[i]).toFixed(1);

    ctx.fillStyle = "rgba(52, 211, 153, 0.8)";
    ctx.font = "10px IBM Plex Mono, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${ratio}×`, x + 18, (ny + iy) / 2 + 3);
  });

  // Legend
  const legend = $("#cardinality-legend");
  legend.innerHTML = `
    <span><span class="legend-swatch" style="background:#f87171"></span>Naive (40K refs × 15 B each)</span>
    <span><span class="legend-swatch" style="background:#34d399"></span>Interned (unique × 15 B + 40K × 4 B IDs)</span>
  `;
}

/* ─── Helpers ────────────────────────────────────────────────────── */

function truncStr(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatKB(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/* ─── Orchestration ──────────────────────────────────────────────── */

function refresh() {
  const count = Number($("#series-slider").value);
  series = generateSeries(count);
  const stats = computeStats(series);

  renderGenSummary(stats);
  renderStats(stats);
  renderNaivePanel(stats);
  renderInternedPanel(stats);
  renderMemoryBars(stats);
  renderCardinalityChart();
}

/* ─── Init ───────────────────────────────────────────────────────── */

function init() {
  // Breadcrumb
  $("#breadcrumb-nav").innerHTML = buildBreadcrumb("String Interning");

  // Slider live update
  const slider = $("#series-slider");
  const display = $("#series-count-display");
  slider.addEventListener("input", () => {
    display.textContent = slider.value;
  });

  // Generate button
  $("#btn-generate").addEventListener("click", refresh);

  // Animation controls
  $("#btn-anim-next").addEventListener("click", () => {
    if (!stepper || stepper.current >= stepper.total - 1) {
      runInternAnimation();
    } else {
      stepper.next();
    }
  });
  $("#btn-anim-prev").addEventListener("click", () => stepper?.prev());
  $("#btn-anim-play").addEventListener("click", () => {
    runInternAnimation();
    if (stepper) {
      // Auto-advance after first step
      setTimeout(() => stepper?.play(1400), 200);
    }
  });
  $("#btn-anim-reset").addEventListener("click", () => {
    setupHashGrid();
    resetAnimation();
  });

  // String select change resets animation state
  $("#anim-string-select").addEventListener("change", () => {
    clearHashGridHighlights();
    if (stepper) stepper.stop();
    stepper = null;
    resetAnimation();
  });

  // Initial render
  setupAnimation();
  refresh();

  // Resize handler for canvas
  window.addEventListener("resize", () => renderCardinalityChart());
}

document.addEventListener("DOMContentLoaded", init);
