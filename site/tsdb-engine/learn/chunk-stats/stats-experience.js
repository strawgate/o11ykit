/**
 * Chunk Stats — Interactive Experience
 *
 * Demonstrates how pre-computed chunk statistics (min, max, sum, count)
 * let the TSDB engine answer aggregation queries without decompressing data.
 */

import {
  $,
  $$,
  animateValue,
  buildBreadcrumb,
  drawSparkline,
  el,
  fmt,
  generateSamples,
  initGlossary,
  revealSection,
} from "../shared.js";

/* ─── Constants ───────────────────────────────────────────────────── */

const NUM_CHUNKS = 12;
const SAMPLES_PER_CHUNK = 64;
const TOTAL_SAMPLES = NUM_CHUNKS * SAMPLES_PER_CHUNK;

/* ─── Data Generation ─────────────────────────────────────────────── */

function generateChunkedData() {
  const { values } = generateSamples("temperature", TOTAL_SAMPLES, {
    base: 22,
    noise: 0.15,
  });

  const chunks = [];
  const baseTime = Date.now() - NUM_CHUNKS * 3600_000;

  for (let c = 0; c < NUM_CHUNKS; c++) {
    const start = c * SAMPLES_PER_CHUNK;
    const end = start + SAMPLES_PER_CHUNK;
    const slice = Array.from(values.slice(start, end));

    const min = Math.min(...slice);
    const max = Math.max(...slice);
    const sum = slice.reduce((a, b) => a + b, 0);
    const count = slice.length;
    const first = slice[0];
    const last = slice[count - 1];

    chunks.push({
      id: c,
      values: slice,
      startTime: baseTime + c * 3600_000,
      endTime: baseTime + (c + 1) * 3600_000,
      stats: { min, max, sum, count, first, last },
    });
  }

  return { allValues: Array.from(values), chunks };
}

const DATA = generateChunkedData();

/* ─── Helpers ─────────────────────────────────────────────────────── */

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtVal(v) {
  return v.toFixed(2);
}

/* ─── A. Full-dataset Sparkline ───────────────────────────────────── */

function drawFullSparkline() {
  const canvas = $("#sparkline-canvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const vals = DATA.allValues;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 6;

  // draw chunk boundary lines first
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(96, 165, 250, 0.18)";
  ctx.lineWidth = 1;
  for (let i = 1; i < NUM_CHUNKS; i++) {
    const x = ((i * SAMPLES_PER_CHUNK) / (vals.length - 1)) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // chunk label background bands (alternating subtle)
  for (let i = 0; i < NUM_CHUNKS; i++) {
    if (i % 2 === 0) continue;
    const x0 = ((i * SAMPLES_PER_CHUNK) / (vals.length - 1)) * w;
    const x1 = (((i + 1) * SAMPLES_PER_CHUNK) / (vals.length - 1)) * w;
    ctx.fillStyle = "rgba(96, 165, 250, 0.03)";
    ctx.fillRect(x0, 0, x1 - x0, h);
  }

  // draw the sparkline
  ctx.beginPath();
  for (let i = 0; i < vals.length; i++) {
    const x = (i / (vals.length - 1)) * w;
    const y = pad + (1 - (vals[i] - min) / range) * (h - 2 * pad);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#60a5fa";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // fill under curve
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = "rgba(96, 165, 250, 0.08)";
  ctx.fill();

  // chunk number labels at top
  ctx.font = `500 ${(10 * dpr) / dpr}px "Space Grotesk", sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(96, 165, 250, 0.4)";
  for (let i = 0; i < NUM_CHUNKS; i++) {
    const cx = (((i + 0.5) * SAMPLES_PER_CHUNK) / (vals.length - 1)) * w;
    ctx.fillText(`C${i}`, cx, 14);
  }
}

/* ─── B. Chunk Timeline ───────────────────────────────────────────── */

let _selectedChunkId = null;

function buildTimeline() {
  const strip = $("#timeline-strip");
  strip.innerHTML = "";

  const globalMin = Math.min(...DATA.chunks.map((c) => c.stats.min));
  const globalMax = Math.max(...DATA.chunks.map((c) => c.stats.max));
  const globalRange = globalMax - globalMin || 1;

  DATA.chunks.forEach((chunk) => {
    const { id, stats } = chunk;
    const barHeight = 20 + ((stats.max - stats.min) / globalRange) * 28;

    const block = el(
      "div",
      { class: "cs-chunk-block", "data-id": String(id) },
      el("span", { class: "chunk-num" }, `C${id}`),
      el("span", { class: "chunk-time" }, `${fmtTime(chunk.startTime)}`),
      el("div", { class: "chunk-range-bar", style: { height: `${barHeight}px` } }),
      el("span", { class: "chunk-count" }, `n=${stats.count}`)
    );

    block.addEventListener("click", () => selectChunk(id));
    strip.appendChild(block);
  });
}

function selectChunk(id) {
  _selectedChunkId = id;
  const chunk = DATA.chunks[id];

  // update selected highlight
  $$(".cs-chunk-block").forEach((b) => {
    b.classList.toggle("selected", Number(b.dataset.id) === id);
  });

  const detail = $("#chunk-detail");
  detail.hidden = false;

  // header
  $("#detail-header").innerHTML = `
    <h3><span class="xp-term" data-term="chunk">Chunk</span> ${id}</h3>
    <span class="time-range">${fmtTime(chunk.startTime)} – ${fmtTime(chunk.endTime)}</span>
  `;

  // stats
  const { stats } = chunk;
  $("#detail-stats").innerHTML = [
    { label: "Min", value: fmtVal(stats.min), color: "var(--xp-accent)" },
    { label: "Max", value: fmtVal(stats.max), color: "var(--xp-error)" },
    { label: "Sum", value: fmt(stats.sum, 1), color: "var(--xp-success)" },
    { label: "Count", value: String(stats.count), color: "var(--xp-warn)" },
    { label: "First", value: fmtVal(stats.first), color: "var(--xp-text)" },
    { label: "Last", value: fmtVal(stats.last), color: "var(--xp-text)" },
  ]
    .map(
      (s) => `
    <div class="xp-stat">
      <span class="xp-stat-label">${s.label}</span>
      <span class="xp-stat-value" style="color:${s.color}">${s.value}</span>
    </div>
  `
    )
    .join("");

  // mini sparkline
  drawSparkline($("#detail-sparkline"), chunk.values, {
    color: "#60a5fa",
    fillAlpha: 0.12,
    lineWidth: 2,
  });
}

/* ─── C/D. Query Execution ────────────────────────────────────────── */

function runQuery() {
  const agg = $("#agg-select").value;
  const stepSize = Number($("#step-select").value);
  const rangeChunks = Number($("#range-slider").value);

  const startChunk = NUM_CHUNKS - rangeChunks;
  const chunks = DATA.chunks.slice(startChunk, NUM_CHUNKS);

  // build buckets
  const buckets = [];
  for (let i = 0; i < chunks.length; i += stepSize) {
    const bucketChunks = chunks.slice(i, i + stepSize);
    buckets.push({ index: buckets.length, chunks: bucketChunks });
  }

  // highlight the matching explain card
  $$(".cs-explain-card").forEach((card) => {
    card.classList.toggle("highlight", card.dataset.agg === agg);
  });

  showExecution(buckets, agg, startChunk);
}

function showExecution(buckets, agg, _startChunk) {
  const execSection = $("#execution-section");
  execSection.hidden = false;
  revealSection(execSection);

  const resultsSection = $("#results-section");
  resultsSection.hidden = true;

  $("#exec-description").innerHTML =
    `Running ${agg}() over ${buckets.reduce((s, b) => s + b.chunks.length, 0)} <span class="xp-term" data-term="chunk">chunks</span> in ${buckets.length} buckets…`;

  const grid = $("#exec-grid");
  grid.innerHTML = "";

  // build the execution grid rows
  const rows = buckets.map((bucket, bi) => {
    const row = el(
      "div",
      { class: "cs-bucket-row" },
      el("span", { class: "cs-bucket-label" }, `Bucket ${bi}`)
    );

    const chipsContainer = el("div", { class: "cs-bucket-chunks" });
    const chips = bucket.chunks.map((chunk) => {
      const chip = el(
        "div",
        {
          class: "cs-exec-chip",
          "data-chunk": String(chunk.id),
        },
        el("span", { class: "chip-icon" }, "⏳"),
        `C${chunk.id}`
      );
      chipsContainer.appendChild(chip);
      return chip;
    });

    const resultEl = el("span", { class: "cs-bucket-result" }, "—");
    row.appendChild(chipsContainer);
    row.appendChild(resultEl);
    grid.appendChild(row);

    return { row, chips, resultEl, bucket };
  });

  // animate bucket-by-bucket
  let totalDecoded = 0;
  let totalStatsOnly = 0;
  let totalSkipped = 0;
  let bucketIdx = 0;

  const bucketResults = [];

  function processBucket() {
    if (bucketIdx >= rows.length) {
      showResults(bucketResults, agg, totalDecoded, totalStatsOnly, totalSkipped);
      return;
    }

    const { row, chips, resultEl, bucket } = rows[bucketIdx];
    row.classList.add("active");

    let chipIdx = 0;
    let runningValue = null;

    function processChip() {
      if (chipIdx >= chips.length) {
        // bucket done
        resultEl.textContent = fmtVal(runningValue ?? 0);
        resultEl.classList.add("visible");
        row.classList.remove("active");
        row.classList.add("done");

        const allStatsOnly = chips.every((c) => c.classList.contains("stats-only"));
        bucketResults.push({
          bucketIndex: bucketIdx,
          value: runningValue,
          method: allStatsOnly ? "stats-only" : "decoded",
          chunks: bucket.chunks,
        });

        bucketIdx++;
        setTimeout(processBucket, 200);
        return;
      }

      const chip = chips[chipIdx];
      const chunk = bucket.chunks[chipIdx];
      const { stats } = chunk;

      // determine decision
      const decision = decideChunk(agg, stats, runningValue, bucket.chunks.length);

      // apply the decision with animation
      setTimeout(() => {
        chip.querySelector(".chip-icon").textContent = decision.icon;
        chip.classList.add(decision.cls);
        chip.classList.add(decision.flashCls);

        if (decision.type === "stats-only") {
          totalStatsOnly++;
          runningValue = mergeResult(agg, runningValue, stats);
        } else if (decision.type === "must-decode") {
          totalDecoded++;
          runningValue = mergeResult(agg, runningValue, stats);
        } else {
          totalSkipped++;
        }

        // remove flash after animation
        setTimeout(() => chip.classList.remove(decision.flashCls), 500);

        chipIdx++;
        setTimeout(processChip, 300);
      }, 150);
    }

    processChip();
  }

  setTimeout(processBucket, 300);
}

function decideChunk(agg, stats, runningValue, bucketSize) {
  if (agg === "max") {
    if (bucketSize === 1) {
      return { type: "stats-only", cls: "stats-only", flashCls: "flash-green", icon: "✓" };
    }
    // multi-chunk bucket: can skip if chunk.max <= running max
    if (runningValue !== null && stats.max <= runningValue) {
      return { type: "skipped", cls: "skipped", flashCls: "", icon: "⊘" };
    }
    return { type: "stats-only", cls: "stats-only", flashCls: "flash-green", icon: "✓" };
  }

  if (agg === "min") {
    if (bucketSize === 1) {
      return { type: "stats-only", cls: "stats-only", flashCls: "flash-green", icon: "✓" };
    }
    if (runningValue !== null && stats.min >= runningValue) {
      return { type: "skipped", cls: "skipped", flashCls: "", icon: "⊘" };
    }
    return { type: "stats-only", cls: "stats-only", flashCls: "flash-green", icon: "✓" };
  }

  if (agg === "sum") {
    // sum: if 1-chunk bucket → stats-only, otherwise must accumulate (but still from stats)
    return { type: "stats-only", cls: "stats-only", flashCls: "flash-green", icon: "✓" };
  }

  if (agg === "avg") {
    // avg: needs sum and count from each chunk — stats-only if aligned
    if (bucketSize === 1) {
      return { type: "stats-only", cls: "stats-only", flashCls: "flash-green", icon: "✓" };
    }
    // multi-chunk: we can still compute from chunk.sum/chunk.count
    return { type: "stats-only", cls: "stats-only", flashCls: "flash-green", icon: "✓" };
  }

  return { type: "must-decode", cls: "must-decode", flashCls: "flash-red", icon: "⚙" };
}

function mergeResult(agg, running, stats) {
  if (running === null) {
    if (agg === "avg") return { sum: stats.sum, count: stats.count };
    if (agg === "max") return stats.max;
    if (agg === "min") return stats.min;
    if (agg === "sum") return stats.sum;
  }

  switch (agg) {
    case "max":
      return Math.max(running, stats.max);
    case "min":
      return Math.min(running, stats.min);
    case "sum":
      return running + stats.sum;
    case "avg":
      return { sum: running.sum + stats.sum, count: running.count + stats.count };
    default:
      return running;
  }
}

/* ─── E. Results Dashboard ────────────────────────────────────────── */

function showResults(bucketResults, agg, decoded, statsOnly, skipped) {
  const section = $("#results-section");
  section.hidden = false;

  const total = decoded + statsOnly + skipped;
  const statsPercent = total > 0 ? Math.round((statsOnly / total) * 100) : 0;
  // rough speedup: stats-only is ~100x, decoded is 1x, skipped is free
  const effectiveWork = decoded + statsOnly * 0.01 + skipped * 0;
  const baselineWork = total;
  const speedup = effectiveWork > 0 ? baselineWork / effectiveWork : baselineWork;

  // summary stats
  $("#result-summary-stats").innerHTML = [
    { label: "Total Chunks", value: String(total), color: "var(--xp-accent)" },
    { label: "Stats-only", value: String(statsOnly), color: "var(--xp-success)" },
    { label: "Decoded", value: String(decoded), color: "var(--xp-error)" },
    { label: "Skipped", value: String(skipped), color: "var(--xp-text-dim)" },
  ]
    .map(
      (s) => `
    <div class="xp-stat">
      <span class="xp-stat-label">${s.label}</span>
      <span class="xp-stat-value" style="color:${s.color}">${s.value}</span>
    </div>
  `
    )
    .join("");

  // speedup card
  const speedupCard = $("#speedup-card");
  speedupCard.innerHTML = `
    <div class="cs-speedup-value" id="speedup-number">1×</div>
    <div class="cs-speedup-label">Estimated Speedup</div>
    <div class="cs-speedup-detail">
      Stats answered ${statsOnly} of ${total} chunks (${statsPercent}%)${skipped > 0 ? ` — ${skipped} skipped entirely` : ""}
    </div>
  `;

  // animate the speedup number
  const speedupEl = $("#speedup-number");
  animateValue(1, speedup, 800, (v) => {
    speedupEl.textContent = `${Math.round(v)}×`;
  });

  // bucket results grid
  const resultsGrid = $("#bucket-results");
  resultsGrid.innerHTML = "";

  bucketResults.forEach((br, i) => {
    let displayValue;
    if (agg === "avg" && br.value && typeof br.value === "object") {
      displayValue = fmtVal(br.value.sum / br.value.count);
    } else if (typeof br.value === "number") {
      displayValue = agg === "sum" ? fmt(br.value, 1) : fmtVal(br.value);
    } else {
      displayValue = "—";
    }

    const cell = el(
      "div",
      {
        class: "cs-result-cell",
        style: { animationDelay: `${i * 60}ms` },
      },
      el("span", { class: "cell-label" }, `Bucket ${i}`),
      el("span", { class: "cell-value" }, displayValue),
      el(
        "span",
        {
          class: `cell-method ${br.method}`,
        },
        br.method === "stats-only" ? "✓ stats" : "⚙ decoded"
      )
    );
    resultsGrid.appendChild(cell);
  });

  revealSection(section);

  const skipLogic = document.getElementById("skip-logic-section");
  if (skipLogic) skipLogic.hidden = false;
}

/* ─── Init ────────────────────────────────────────────────────────── */

function init() {
  // breadcrumb
  $("#breadcrumb-nav").innerHTML = buildBreadcrumb("Chunk Stats");

  // draw the full sparkline
  drawFullSparkline();
  window.addEventListener("resize", drawFullSparkline);

  // build timeline
  buildTimeline();

  // select first chunk by default
  selectChunk(0);

  // range slider
  const rangeSlider = $("#range-slider");
  const rangeValue = $("#range-value");
  rangeSlider.addEventListener("input", () => {
    rangeValue.textContent = `${rangeSlider.value} chunks`;
  });

  // run query button
  $("#btn-run").addEventListener("click", runQuery);

  // highlight explain card on aggregation change
  $("#agg-select").addEventListener("change", () => {
    const agg = $("#agg-select").value;
    $$(".cs-explain-card").forEach((card) => {
      card.classList.toggle("highlight", card.dataset.agg === agg);
    });
  });

  initGlossary();
}

init();
