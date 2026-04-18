/**
 * Query Engine — Interactive Experience
 *
 * Demonstrates the end-to-end query flow in a TSDB:
 * Label Match → Postings Intersection → Chunk Pruning →
 * Stats Check → Decode → Step-Aligned Aggregation
 */

import {
  $,
  $$,
  buildBreadcrumb,
  drawSparkline,
  el,
  fmt,
  revealSection,
  Stepper,
  sleep,
} from "../shared.js";

/* ═══════════════════════════════════════════════════════════════════════
   A. DATASET GENERATION
   ═══════════════════════════════════════════════════════════════════════ */

const METRICS = ["http_requests", "cpu_usage", "memory_bytes"];
const REGIONS = ["us-east-1", "us-west-2"];
const JOBS = ["api", "web", "worker"];
const CHUNKS_PER_SERIES = 5;
const SAMPLES_PER_CHUNK = 240; // 15s interval × 1 hour
const CHUNK_DURATION_MS = 3_600_000; // 1 hour

function generateDataset() {
  const series = [];
  let nextId = 0;

  for (const metric of METRICS) {
    for (const region of REGIONS) {
      for (const job of JOBS) {
        series.push({
          id: nextId++,
          metric,
          labels: { region, job },
        });
      }
    }
  }

  // Generate chunks for each series
  const baseTime = Date.now() - CHUNKS_PER_SERIES * CHUNK_DURATION_MS;

  for (const s of series) {
    s.chunks = [];
    for (let c = 0; c < CHUNKS_PER_SERIES; c++) {
      const startTime = baseTime + c * CHUNK_DURATION_MS;
      const endTime = startTime + CHUNK_DURATION_MS;
      const samples = generateChunkSamples(s.metric, s.id, c);
      const min = Math.min(...samples);
      const max = Math.max(...samples);
      const sum = samples.reduce((a, b) => a + b, 0);
      s.chunks.push({
        chunkIndex: c,
        startTime,
        endTime,
        sampleCount: samples.length,
        samples,
        stats: { min, max, sum, count: samples.length },
      });
    }
  }

  return series;
}

function generateChunkSamples(metric, seriesId, chunkIdx) {
  const samples = [];
  const seed = seriesId * 100 + chunkIdx * 17;

  for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
    const t = i / SAMPLES_PER_CHUNK;
    const pseudoRand = seededRand(seed + i);

    switch (metric) {
      case "http_requests":
        samples.push(
          Math.max(
            0,
            50 + seriesId * 12 + Math.sin(t * 6.28 + chunkIdx) * 30 + (pseudoRand - 0.5) * 20
          )
        );
        break;
      case "cpu_usage":
        samples.push(
          Math.max(
            0,
            Math.min(
              100,
              35 + seriesId * 3 + Math.sin(t * 3.14 + chunkIdx * 0.7) * 25 + (pseudoRand - 0.5) * 10
            )
          )
        );
        break;
      case "memory_bytes":
        samples.push(
          Math.max(
            0,
            500_000_000 +
              seriesId * 80_000_000 +
              Math.sin(t * 2.5 + chunkIdx) * 100_000_000 +
              (pseudoRand - 0.5) * 50_000_000
          )
        );
        break;
    }
  }
  return samples;
}

function seededRand(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

const DATASET = generateDataset();

/* ─── Postings index: label→value → sorted series IDs ─────────────── */
const POSTINGS = new Map();

function buildPostingsIndex() {
  for (const s of DATASET) {
    // metric name as __name__
    addPosting("__name__", s.metric, s.id);
    for (const [k, v] of Object.entries(s.labels)) {
      addPosting(k, v, s.id);
    }
  }
}

function addPosting(label, value, seriesId) {
  const key = `${label}=${value}`;
  if (!POSTINGS.has(key)) POSTINGS.set(key, []);
  const list = POSTINGS.get(key);
  if (!list.includes(seriesId)) list.push(seriesId);
  list.sort((a, b) => a - b);
}

buildPostingsIndex();

/* ═══════════════════════════════════════════════════════════════════════
   B. PIPELINE STAGES
   ═══════════════════════════════════════════════════════════════════════ */

const STAGES = [
  { icon: "🏷", label: "Label Match" },
  { icon: "∩", label: "Postings" },
  { icon: "✂", label: "Prune Chunks" },
  { icon: "📊", label: "Stats Check" },
  { icon: "📦", label: "Decode" },
  { icon: "Σ", label: "Aggregate" },
];

let stepper;

function buildPipeline() {
  const bar = $("#pipeline-bar");
  bar.innerHTML = "";

  STAGES.forEach((stage, i) => {
    if (i > 0) {
      bar.appendChild(el("span", { class: "xp-pipe-arrow", "aria-hidden": "true" }, "→"));
    }
    const stageEl = el(
      "div",
      { class: "xp-pipe-stage", "data-stage": String(i) },
      el("span", { class: "stage-icon" }, stage.icon),
      el("span", { class: "stage-label" }, stage.label)
    );
    bar.appendChild(stageEl);
  });

  stepper = new Stepper(STAGES.length, (current) => {
    $$(".xp-pipe-stage", bar).forEach((el, i) => {
      el.classList.remove("active", "done");
      if (i < current) el.classList.add("done");
      else if (i === current) el.classList.add("active");
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   C. QUERY BUILDER
   ═══════════════════════════════════════════════════════════════════════ */

const filters = [{ label: "region", value: "us-west-2" }];

function getAvailableLabels() {
  return ["region", "job"];
}

function getValuesForLabel(label) {
  if (label === "region") return REGIONS;
  if (label === "job") return JOBS;
  return [];
}

function renderFilterRows() {
  const container = $("#filter-rows");
  container.innerHTML = "";

  filters.forEach((f, i) => {
    const labelSelect = el("select", {
      class: "xp-select",
      "data-filter-idx": String(i),
      "data-field": "label",
    });
    for (const lab of getAvailableLabels()) {
      const opt = el("option", { value: lab }, lab);
      if (lab === f.label) opt.selected = true;
      labelSelect.appendChild(opt);
    }

    const valSelect = el("select", {
      class: "xp-select",
      "data-filter-idx": String(i),
      "data-field": "value",
    });
    for (const val of getValuesForLabel(f.label)) {
      const opt = el("option", { value: val }, val);
      if (val === f.value) opt.selected = true;
      valSelect.appendChild(opt);
    }

    const removeBtn = el(
      "button",
      { class: "qe-btn-remove-filter", "data-filter-idx": String(i) },
      "×"
    );

    const row = el(
      "div",
      { class: "qe-filter-row" },
      labelSelect,
      el("span", { class: "qe-filter-eq" }, "="),
      valSelect,
      removeBtn
    );
    container.appendChild(row);

    labelSelect.addEventListener("change", () => {
      filters[i].label = labelSelect.value;
      filters[i].value = getValuesForLabel(labelSelect.value)[0] || "";
      renderFilterRows();
      updateQueryPreview();
    });

    valSelect.addEventListener("change", () => {
      filters[i].value = valSelect.value;
      updateQueryPreview();
    });

    removeBtn.addEventListener("click", () => {
      filters.splice(i, 1);
      renderFilterRows();
      updateQueryPreview();
    });
  });
}

function updateQueryPreview() {
  const metric = $("#metric-select").value;
  const agg = $("#agg-select").value;
  const step = $("#step-select").value;
  const range = $("#range-select").value;

  let filterStr = "";
  if (filters.length > 0) {
    const parts = filters.map(
      (f) =>
        `<span class="qp-label">${f.label}</span><span class="qp-op">=</span><span class="qp-value">"${f.value}"</span>`
    );
    filterStr = `{${parts.join('<span class="qp-op">, </span>')}}`;
  }

  const preview = $("#query-preview");
  preview.innerHTML = `<span class="qp-fn">${agg}</span>(<span class="qp-metric">${metric}</span>${filterStr}[<span class="qp-value">${range}h</span>:<span class="qp-value">${step}m</span>])`;
}

/* ═══════════════════════════════════════════════════════════════════════
   D. STAGE 1 — LABEL MATCHING & POSTINGS INTERSECTION
   ═══════════════════════════════════════════════════════════════════════ */

function intersectSorted(a, b) {
  const result = [];
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return result;
}

function resolvePostings(metric, labelFilters) {
  // Start with the metric postings
  const metricKey = `__name__=${metric}`;
  let current = POSTINGS.get(metricKey) || [];
  const lists = [{ key: metricKey, ids: [...current] }];

  for (const f of labelFilters) {
    const key = `${f.label}=${f.value}`;
    const plist = POSTINGS.get(key) || [];
    lists.push({ key, ids: [...plist] });
    current = intersectSorted(current, plist);
  }

  return { lists, intersection: current };
}

async function animateLabelMatch(metric, labelFilters) {
  const section = $("#stage-match-section");
  section.hidden = false;

  const { lists, intersection } = resolvePostings(metric, labelFilters);
  const vizContainer = $("#match-viz");
  vizContainer.innerHTML = "";

  // Only show filter-level postings (skip __name__ for visual clarity if there are filters)
  const displayLists = lists.length > 1 ? lists.slice(1) : lists;
  const colors = ["color-a", "color-b"];

  // Description
  const desc = $("#match-description");
  desc.textContent = `Each label filter maps to a sorted postings list. We intersect them using galloping search.`;

  // Render postings lists
  const postingsGroups = [];
  displayLists.forEach((pl, idx) => {
    const group = el("div", { class: "qe-postings-group" });
    const label = el(
      "div",
      { class: "qe-postings-label" },
      `Postings for `,
      el("span", { class: "filter-text" }, pl.key),
      ` (${pl.ids.length} series)`
    );
    group.appendChild(label);

    const row = el("div", { class: "qe-postings-row" });
    const idEls = pl.ids.map((id) => {
      const idEl = el("div", { class: `qe-posting-id ${colors[idx % 2]}` }, String(id));
      row.appendChild(idEl);
      return { id, el: idEl };
    });
    group.appendChild(row);
    vizContainer.appendChild(group);
    postingsGroups.push({ ids: pl.ids, idEls, key: pl.key });
  });

  // Intersection result row
  const intLabel = el(
    "div",
    { class: "qe-intersection-label" },
    el("span", { class: "arrow-icon" }, "↓"),
    " Intersection Result"
  );
  vizContainer.appendChild(intLabel);

  const intRow = el("div", { class: "qe-postings-row" });
  vizContainer.appendChild(intRow);

  // Animate the intersection
  if (displayLists.length >= 2) {
    await animateGallopingIntersection(postingsGroups, intersection, intRow);
  } else {
    // Single list = all match
    for (const id of displayLists[0]?.ids || intersection) {
      const idEl = el("div", { class: "qe-posting-id match" }, String(id));
      intRow.appendChild(idEl);
    }
  }

  // Summary
  const summary = $("#match-summary");
  summary.innerHTML = "";
  for (const pl of displayLists) {
    summary.appendChild(
      el(
        "div",
        { class: "qe-summary-chip" },
        el("strong", {}, String(pl.ids.length)),
        ` match ${pl.key}`
      )
    );
  }
  summary.appendChild(
    el(
      "div",
      { class: "qe-summary-chip" },
      "→ ",
      el("strong", {}, String(intersection.length)),
      " in intersection"
    )
  );
}

async function animateGallopingIntersection(groups, intersection, resultRow) {
  // We animate through the first two lists
  const listA = groups[0];
  const listB = groups[1];
  let i = 0,
    j = 0;

  const _interSet = new Set(intersection);

  while (i < listA.ids.length && j < listB.ids.length) {
    // Highlight current scanning position
    listA.idEls[i].el.classList.add("scanning");
    listB.idEls[j].el.classList.add("scanning");

    await sleep(80);

    if (listA.ids[i] === listB.ids[j]) {
      // Match
      listA.idEls[i].el.classList.remove("scanning");
      listA.idEls[i].el.classList.add("match");
      listB.idEls[j].el.classList.remove("scanning");
      listB.idEls[j].el.classList.add("match");

      const matchEl = el(
        "div",
        { class: "qe-posting-id match qe-flash-green" },
        String(listA.ids[i])
      );
      resultRow.appendChild(matchEl);

      i++;
      j++;
    } else if (listA.ids[i] < listB.ids[j]) {
      listA.idEls[i].el.classList.remove("scanning");
      listA.idEls[i].el.classList.add("dimmed");
      i++;
    } else {
      listB.idEls[j].el.classList.remove("scanning");
      listB.idEls[j].el.classList.add("dimmed");
      j++;
    }

    await sleep(50);
  }

  // Dim remaining
  while (i < listA.ids.length) {
    listA.idEls[i].el.classList.add("dimmed");
    i++;
  }
  while (j < listB.ids.length) {
    listB.idEls[j].el.classList.add("dimmed");
    j++;
  }

  // If more than 2 filters, apply further intersection (non-animated)
  if (groups.length > 2) {
    const resultIds = [...resultRow.children].map((c) => Number(c.textContent));
    for (let g = 2; g < groups.length; g++) {
      const filtered = intersectSorted(resultIds, groups[g].ids);
      const filteredSet = new Set(filtered);
      for (const child of [...resultRow.children]) {
        if (!filteredSet.has(Number(child.textContent))) {
          child.classList.remove("match");
          child.classList.add("dimmed");
        }
      }
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   E. STAGE 2 — CHUNK PRUNING
   ═══════════════════════════════════════════════════════════════════════ */

async function animateChunkPruning(matchedSeriesIds, queryRangeHours) {
  const section = $("#stage-prune-section");
  section.hidden = false;

  const vizContainer = $("#prune-viz");
  vizContainer.innerHTML = "";

  const now = Date.now();
  const rangeStart = now - queryRangeHours * CHUNK_DURATION_MS;
  const rangeEnd = now;

  // We'll show a subset of matched series (max 6 for readability)
  const displayIds = matchedSeriesIds.slice(0, 6);
  const matchedSeries = displayIds.map((id) => DATASET[id]);

  // Time axis min/max (full range across all chunks)
  const allStart = Math.min(...matchedSeries.flatMap((s) => s.chunks.map((c) => c.startTime)));
  const allEnd = Math.max(...matchedSeries.flatMap((s) => s.chunks.map((c) => c.endTime)));

  const desc = $("#prune-description");
  desc.textContent = `Binary-search each series' chunk list to find chunks overlapping the query time range [${fmtHour(rangeStart)} – ${fmtHour(rangeEnd)}].`;

  const timeline = el("div", { class: "qe-prune-timeline" });

  // Time axis labels
  const axisRow = el("div", { class: "qe-prune-axis" });
  for (let h = 0; h <= CHUNKS_PER_SERIES; h++) {
    const t = allStart + (h / CHUNKS_PER_SERIES) * (allEnd - allStart);
    axisRow.appendChild(el("span", {}, fmtHour(t)));
  }
  timeline.appendChild(axisRow);

  let totalChunks = 0;
  let inRangeCount = 0;
  let prunedCount = 0;
  const allChunkEls = [];

  // Series rows
  for (const s of matchedSeries) {
    const row = el("div", { class: "qe-prune-series-row" });
    const label = el("div", { class: "qe-prune-series-label" }, `S${s.id}`);
    row.appendChild(label);

    const chunksBar = el("div", { class: "qe-prune-chunks-bar" });

    for (const chunk of s.chunks) {
      totalChunks++;
      const overlaps = chunk.endTime > rangeStart && chunk.startTime < rangeEnd;
      const chunkEl = el("div", { class: "qe-prune-chunk" });
      chunksBar.appendChild(chunkEl);
      allChunkEls.push({ el: chunkEl, overlaps });

      if (overlaps) inRangeCount++;
      else prunedCount++;
    }

    row.appendChild(chunksBar);
    timeline.appendChild(row);
  }

  vizContainer.appendChild(timeline);

  // Animate chunks lighting up / dimming
  for (const item of allChunkEls) {
    if (item.overlaps) {
      item.el.classList.add("in-range");
    } else {
      item.el.classList.add("pruned");
    }
    await sleep(30);
  }

  // Summary
  const summary = $("#prune-summary");
  summary.innerHTML = "";
  summary.appendChild(
    el("div", { class: "qe-summary-chip" }, el("strong", {}, String(totalChunks)), " chunks total")
  );
  summary.appendChild(
    el("div", { class: "qe-summary-chip" }, el("strong", {}, String(inRangeCount)), " in range")
  );
  summary.appendChild(
    el("div", { class: "qe-summary-chip" }, el("strong", {}, String(prunedCount)), " pruned")
  );

  return { totalChunks, inRangeCount, prunedCount };
}

/* ═══════════════════════════════════════════════════════════════════════
   F. STAGE 3 — STEP-ALIGNED AGGREGATION
   ═══════════════════════════════════════════════════════════════════════ */

async function animateAggregation(matchedSeriesIds, queryRangeHours, stepMinutes, aggFn) {
  const section = $("#stage-agg-section");
  section.hidden = false;

  const vizContainer = $("#agg-viz");
  vizContainer.innerHTML = "";

  const now = Date.now();
  const rangeStart = now - queryRangeHours * CHUNK_DURATION_MS;
  const rangeEnd = now;
  const stepMs = stepMinutes * 60_000;
  const numBuckets = Math.ceil((rangeEnd - rangeStart) / stepMs);

  const desc = $("#agg-description");
  desc.textContent = `Dividing the ${queryRangeHours}h range into ${numBuckets} buckets of ${stepMinutes}min each. Folding samples with ${aggFn}().`;

  // Collect all samples in range from matched series
  const matchedSeries = matchedSeriesIds.map((id) => DATASET[id]);
  const bucketSamples = Array.from({ length: numBuckets }, () => []);

  for (const s of matchedSeries) {
    for (const chunk of s.chunks) {
      if (chunk.endTime <= rangeStart || chunk.startTime >= rangeEnd) continue;
      const sampleInterval = CHUNK_DURATION_MS / chunk.sampleCount;
      for (let i = 0; i < chunk.sampleCount; i++) {
        const t = chunk.startTime + i * sampleInterval;
        if (t >= rangeStart && t < rangeEnd) {
          const bucketIdx = Math.min(Math.floor((t - rangeStart) / stepMs), numBuckets - 1);
          bucketSamples[bucketIdx].push(chunk.samples[i]);
        }
      }
    }
  }

  // Build bucket elements
  const bucketsRow = el("div", { class: "qe-agg-buckets" });
  const bucketEls = [];

  for (let b = 0; b < numBuckets; b++) {
    const bucketStart = rangeStart + b * stepMs;
    const bucket = el(
      "div",
      { class: "qe-agg-bucket" },
      el("span", { class: "qe-bucket-label" }, `Bucket ${b}`),
      el("span", { class: "qe-bucket-time" }, fmtHour(bucketStart))
    );

    // Sample dots (max 20 shown for visual clarity)
    const dotCount = Math.min(bucketSamples[b].length, 20);
    const dotsContainer = el("div", { class: "qe-bucket-dots" });
    const dots = [];
    for (let d = 0; d < dotCount; d++) {
      const dot = el("div", { class: "qe-sample-dot" });
      dotsContainer.appendChild(dot);
      dots.push(dot);
    }
    bucket.appendChild(dotsContainer);

    const accEl = el("span", { class: "qe-bucket-accumulator" }, "—");
    bucket.appendChild(accEl);

    const countEl = el("span", { class: "qe-bucket-count" }, "");
    bucket.appendChild(countEl);

    bucketsRow.appendChild(bucket);
    bucketEls.push({ el: bucket, dots, accEl, countEl, samples: bucketSamples[b] });
  }

  vizContainer.appendChild(bucketsRow);

  // Animate bucket by bucket
  const results = [];
  for (let b = 0; b < bucketEls.length; b++) {
    const be = bucketEls[b];
    be.el.classList.add("active");

    // Animate dots appearing
    for (const dot of be.dots) {
      dot.classList.add("visible");
      await sleep(15);
    }

    // Compute aggregation
    const val = computeAgg(be.samples, aggFn);
    results.push(val);

    be.accEl.textContent = formatAggValue(val, aggFn);
    be.countEl.textContent = `n=${fmt(be.samples.length)}`;
    be.el.classList.remove("active");
    be.el.classList.add("done");

    await sleep(120);
  }

  return results;
}

function computeAgg(samples, fn) {
  if (samples.length === 0) return 0;
  switch (fn) {
    case "sum":
      return samples.reduce((a, b) => a + b, 0);
    case "avg":
      return samples.reduce((a, b) => a + b, 0) / samples.length;
    case "max":
      return Math.max(...samples);
    case "min":
      return Math.min(...samples);
    default:
      return 0;
  }
}

function formatAggValue(val, fn) {
  if (fn === "sum") return fmt(val, 1);
  if (fn === "avg") return val.toFixed(2);
  if (fn === "max" || fn === "min") return val.toFixed(2);
  return val.toFixed(2);
}

/* ═══════════════════════════════════════════════════════════════════════
   G. RESULTS
   ═══════════════════════════════════════════════════════════════════════ */

function showResults(aggResults, matchedCount, pruneStats, aggFn, stepMinutes, queryRangeHours) {
  const section = $("#results-section");
  section.hidden = false;

  // Stats
  const _totalSamples = matchedCount * CHUNKS_PER_SERIES * SAMPLES_PER_CHUNK;
  const decodedChunks = pruneStats.inRangeCount;

  const statsRow = $("#result-stats");
  statsRow.innerHTML = [
    { label: "Series Scanned", value: String(matchedCount), color: "var(--xp-accent)" },
    { label: "Chunks Decoded", value: String(decodedChunks), color: "var(--xp-success)" },
    { label: "Chunks Pruned", value: String(pruneStats.prunedCount), color: "var(--xp-text-dim)" },
    { label: "Output Buckets", value: String(aggResults.length), color: "var(--xp-warn)" },
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

  // Sparkline
  drawSparkline($("#result-sparkline"), aggResults, {
    color: "#34d399",
    fillAlpha: 0.15,
    lineWidth: 2,
  });

  // Results table
  const now = Date.now();
  const rangeStart = now - queryRangeHours * CHUNK_DURATION_MS;
  const stepMs = stepMinutes * 60_000;

  const tableContainer = $("#result-table");
  const table = el("table");
  const thead = el("thead");
  thead.appendChild(
    el("tr", {}, el("th", {}, "Bucket"), el("th", {}, "Time"), el("th", {}, `${aggFn}()`))
  );
  table.appendChild(thead);

  const tbody = el("tbody");
  aggResults.forEach((val, i) => {
    const t = rangeStart + i * stepMs;
    const row = el(
      "tr",
      {},
      el("td", {}, String(i)),
      el("td", {}, fmtHour(t)),
      el("td", {}, formatAggValue(val, aggFn))
    );
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  tableContainer.innerHTML = "";
  tableContainer.appendChild(table);

  revealSection(section);
}

/* ═══════════════════════════════════════════════════════════════════════
   QUERY EXECUTION ORCHESTRATOR
   ═══════════════════════════════════════════════════════════════════════ */

let _running = false;

async function executeQuery() {
  if (_running) return;
  _running = true;

  const btn = $("#btn-execute");
  btn.disabled = true;
  btn.textContent = "⏳ Running…";

  // Hide previous results
  for (const id of [
    "stage-match-section",
    "stage-prune-section",
    "stage-agg-section",
    "results-section",
  ]) {
    $(` #${id}`).hidden = true;
  }

  const metric = $("#metric-select").value;
  const queryRangeHours = Number($("#range-select").value);
  const stepMinutes = Number($("#step-select").value);
  const aggFn = $("#agg-select").value;

  stepper.reset();

  // Stage 0 & 1: Label Match + Postings Intersection
  stepper.goto(0);
  await sleep(400);
  stepper.goto(1);

  const { intersection } = resolvePostings(metric, filters);
  await animateLabelMatch(metric, filters);
  revealSection($("#stage-match-section"));
  await sleep(600);

  // Stage 2: Chunk Pruning
  stepper.goto(2);
  const pruneStats = await animateChunkPruning(intersection, queryRangeHours);
  revealSection($("#stage-prune-section"));
  await sleep(600);

  // Stage 3: Stats Check (brief pause — conceptual)
  stepper.goto(3);
  await sleep(500);

  // Stage 4: Decode (brief pause — conceptual)
  stepper.goto(4);
  await sleep(500);

  // Stage 5: Aggregation
  stepper.goto(5);
  const aggResults = await animateAggregation(intersection, queryRangeHours, stepMinutes, aggFn);
  revealSection($("#stage-agg-section"));
  await sleep(400);

  // Show results
  showResults(aggResults, intersection.length, pruneStats, aggFn, stepMinutes, queryRangeHours);

  btn.disabled = false;
  btn.textContent = "▶ Execute Query";
  _running = false;
}

/* ═══════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════ */

function fmtHour(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/* ═══════════════════════════════════════════════════════════════════════
   DATASET SUMMARY
   ═══════════════════════════════════════════════════════════════════════ */

function renderDatasetSummary() {
  const totalSeries = DATASET.length;
  const totalChunks = totalSeries * CHUNKS_PER_SERIES;
  const totalSamples = totalChunks * SAMPLES_PER_CHUNK;

  const statsRow = $("#dataset-stats");
  statsRow.innerHTML = [
    { label: "Metrics", value: String(METRICS.length) },
    { label: "Series", value: String(totalSeries) },
    { label: "Chunks", value: fmt(totalChunks) },
    { label: "Samples", value: fmt(totalSamples) },
  ]
    .map(
      (s) => `
    <div class="xp-stat">
      <span class="xp-stat-label">${s.label}</span>
      <span class="xp-stat-value">${s.value}</span>
    </div>
  `
    )
    .join("");

  // Compact dataset table
  const detail = $("#dataset-detail");

  // Group by metric
  const rows = DATASET.map((s) => {
    const labelPills = Object.entries(s.labels)
      .map(([k, v]) => `<span class="label-pill">${k}=${v}</span>`)
      .join(" ");
    return `<tr>
      <td><span class="metric-name">${s.metric}</span></td>
      <td>${labelPills}</td>
      <td>S${s.id}</td>
      <td>${s.chunks.length}</td>
      <td>${fmt(s.chunks.reduce((a, c) => a + c.sampleCount, 0))}</td>
    </tr>`;
  }).join("");

  detail.innerHTML = `
    <table class="qe-dataset-table">
      <thead>
        <tr><th>Metric</th><th>Labels</th><th>ID</th><th>Chunks</th><th>Samples</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════════ */

function init() {
  // Breadcrumb
  $("#breadcrumb-nav").innerHTML = buildBreadcrumb("Query Engine");

  // Dataset
  renderDatasetSummary();

  // Pipeline
  buildPipeline();

  // Query builder
  renderFilterRows();
  updateQueryPreview();

  // Event listeners
  $("#btn-add-filter").addEventListener("click", () => {
    const usedLabels = new Set(filters.map((f) => f.label));
    const available = getAvailableLabels().filter((l) => !usedLabels.has(l));
    const nextLabel = available[0] || getAvailableLabels()[0];
    filters.push({ label: nextLabel, value: getValuesForLabel(nextLabel)[0] });
    renderFilterRows();
    updateQueryPreview();
  });

  for (const id of ["metric-select", "range-select", "step-select", "agg-select"]) {
    $(`#${id}`).addEventListener("change", updateQueryPreview);
  }

  $("#btn-execute").addEventListener("click", executeQuery);
}

init();
