import {
  estimateScenarioArrayBytes,
  generateScenarioData,
  generateValue,
  INSTANCES,
  METRICS,
  REGIONS,
  SCENARIOS,
  scenarioSampleCount,
  scenarioSeriesCount,
  startLiveBrowserScraper,
} from "./data-gen.js";
import { escapeHtml, formatBytes } from "./utils.js";

function formatApproxBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const LARGE_SCENARIO_WARN_BYTES = 128 * 1024 * 1024;
const LARGE_SCENARIO_CONFIRM_BYTES = 256 * 1024 * 1024;
const LOW_MEMORY_DEVICE_GIB = 4;
const LOW_MEMORY_CONFIRM_BYTES = 64 * 1024 * 1024;

function shouldConfirmLargeScenarioLoad(approxBytes) {
  const deviceMemoryGiB =
    typeof navigator !== "undefined" && typeof navigator.deviceMemory === "number"
      ? navigator.deviceMemory
      : null;
  if (approxBytes >= LARGE_SCENARIO_CONFIRM_BYTES) return true;
  return (
    deviceMemoryGiB != null &&
    deviceMemoryGiB <= LOW_MEMORY_DEVICE_GIB &&
    approxBytes >= LOW_MEMORY_CONFIRM_BYTES
  );
}

function confirmLargeScenarioLoad(scenario, approxBytes) {
  const confirmFn =
    typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm : null;
  if (!shouldConfirmLargeScenarioLoad(approxBytes) || !confirmFn) {
    return true;
  }
  return confirmFn(
    [
      `Load ${scenario.name}?`,
      "",
      `This scenario will allocate roughly ${formatApproxBytes(approxBytes)} of raw typed-array data before storage overhead.`,
      "On lower-memory browsers this can stall the page for a few seconds.",
      "",
      "Press OK to continue or Cancel to keep the current dataset.",
    ].join("\n")
  );
}

export function createDatasetController({
  createStore,
  chunkSize,
  nsPerMs,
  onBeforeLoad,
  onDataLoaded,
  onLiveUpdate,
}) {
  function clearScenarioSelection() {
    document.querySelectorAll(".scenario-card").forEach((card) => {
      card.classList.remove("active", "loading", "loaded");
      card.setAttribute("aria-pressed", "false");
    });
  }

  function renderScenarioCards() {
    const grid = document.getElementById("scenarioGrid");
    if (!grid) return;
    const scenarioCards = SCENARIOS.map((s) => {
      const seriesCount = scenarioSeriesCount(s);
      const sampleCount = scenarioSampleCount(s);
      const approxBytes = estimateScenarioArrayBytes(s);
      const interval =
        s.intervalMs >= 60000 ? `${s.intervalMs / 60000}min` : `${s.intervalMs / 1000}s`;
      return `
    <button type="button" class="scenario-card" data-scenario-id="${escapeHtml(s.id)}" aria-pressed="false">
      <span class="sc-selected-badge">✓ Selected</span>
      <div class="sc-emoji">${s.emoji}</div>
      <div class="sc-name">${escapeHtml(s.name)}</div>
      <div class="sc-desc">${escapeHtml(s.description)}</div>
      <div class="sc-meta-label">Sample Metrics:</div>
      <div class="sc-meta">
        ${s.metrics.map((m) => `<span class="sc-metric">${escapeHtml(m.name)}</span>`).join("")}
      </div>
      <div class="sc-stats">${seriesCount.toLocaleString()} series · ${sampleCount.toLocaleString()} pts · ${interval} interval · ~${formatApproxBytes(approxBytes)} raw arrays</div>
      <div class="sc-loading-indicator"><span class="sc-spinner"></span><span class="sc-loading-text">Generating data…</span></div>
      <div class="sc-done-stats"></div>
    </button>`;
    }).join("");

    const customCard = `
    <button type="button" class="scenario-card scenario-card-custom" id="openCustomGenerator" aria-pressed="false">
      <span class="sc-selected-badge">✓ Selected</span>
      <div class="sc-emoji">⚙️</div>
      <div class="sc-name">Custom Generator</div>
      <div class="sc-desc">Choose your own series count, points, data pattern, and sample interval. Full control over the generated dataset.</div>
      <span class="fork-cta" style="margin-top:auto">Open Generator →</span>
    </button>`;

    grid.innerHTML = scenarioCards + customCard;

    grid.querySelectorAll(".scenario-card[data-scenario-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const scenario = SCENARIOS.find((s) => s.id === card.dataset.scenarioId);
        if (scenario) loadScenario(scenario, card);
      });
    });

    document.getElementById("openCustomGenerator")?.addEventListener("click", () => {
      const inline = document.getElementById("customGeneratorInline");
      if (!inline) return;
      const willShow = inline.hidden;
      clearScenarioSelection();
      inline.hidden = !inline.hidden;
      const customCardEl = document.getElementById("openCustomGenerator");
      if (willShow && customCardEl) {
        customCardEl.classList.add("active", "loaded");
        customCardEl.setAttribute("aria-pressed", "true");
        inline.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }

  let _activeScraperStop = null;

  function loadScenario(scenario, clickedCard) {
    if (_activeScraperStop) {
      _activeScraperStop();
      _activeScraperStop = null;
    }

    const approxBytes = estimateScenarioArrayBytes(scenario);
    if (!confirmLargeScenarioLoad(scenario, approxBytes)) {
      clearScenarioSelection();
      const inline = document.getElementById("customGeneratorInline");
      if (inline) inline.hidden = true;
      return;
    }

    clearScenarioSelection();
    const inline = document.getElementById("customGeneratorInline");
    if (inline) inline.hidden = true;
    if (clickedCard) {
      clickedCard.classList.add("active", "loading");
      clickedCard.setAttribute("aria-pressed", "true");
    }

    onBeforeLoad?.();

    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          const backendType = "column";
          if (approxBytes >= LARGE_SCENARIO_WARN_BYTES) {
            console.warn(
              `Generating scenario ${scenario.id} with roughly ${formatApproxBytes(approxBytes)} of typed-array payload before storage overhead.`
            );
          }
          const store = createStore(backendType, chunkSize);
          const metrics = [...new Set(scenario.metrics.map((m) => m.name))];

          if (scenario.isLive) {
            const liveStartedAt = performance.now();
            _activeScraperStop = startLiveBrowserScraper(store, scenario, (_count, appends) => {
              if (clickedCard) {
                const doneEl = clickedCard.querySelector(".sc-done-stats");
                if (doneEl) {
                  const totalPts = store.sampleCount;
                  const memBytes = store.memoryBytes();
                  doneEl.textContent = `Live: ${totalPts.toLocaleString()} pts · ${formatBytes(memBytes)}`;
                }
              }
              onLiveUpdate?.(store, scenario, appends);
            });

            clickedCard.classList.remove("loading");
            clickedCard.classList.add("active", "loaded");
            onDataLoaded(
              store,
              metrics,
              Math.max(1, performance.now() - liveStartedAt),
              0,
              scenario.intervalMs
            );
            return;
          }

          const t0 = performance.now();
          const seriesData = generateScenarioData(scenario);

          if (backendType === "column") {
            const ids = seriesData.map((sd) => store.getOrCreateSeries(sd.labels));
            const numPoints = seriesData[0]?.timestamps.length || 0;
            for (let offset = 0; offset < numPoints; offset += chunkSize) {
              const end = Math.min(offset + chunkSize, numPoints);
              for (let i = 0; i < seriesData.length; i++) {
                store.appendBatch(
                  ids[i],
                  seriesData[i].timestamps.subarray(offset, end),
                  seriesData[i].values.subarray(offset, end)
                );
              }
            }
          } else {
            for (const sd of seriesData) {
              const id = store.getOrCreateSeries(sd.labels);
              store.appendBatch(id, sd.timestamps, sd.values);
            }
          }

          const ingestTime = performance.now() - t0;
          onDataLoaded(store, metrics, ingestTime, scenario.numPoints, scenario.intervalMs);
        } catch (err) {
          console.error("Failed to load scenario:", err);
          if (clickedCard) {
            clickedCard.classList.remove("loading", "active", "loaded");
            clickedCard.setAttribute("aria-pressed", "false");
          }
        }
      }, 30);
    });
  }

  function generateCustomData(numSeries, numPoints, pattern, backendType, intervalMs) {
    if (_activeScraperStop) {
      _activeScraperStop();
      _activeScraperStop = null;
    }
    const store = createStore(backendType, chunkSize);
    const now = BigInt(Date.now()) * nsPerMs;
    const intervalNs = BigInt(intervalMs) * nsPerMs;
    const metricsUsed = new Set();
    const seriesData = [];

    for (let si = 0; si < numSeries; si++) {
      const metricName = METRICS[si % METRICS.length];
      const region = REGIONS[Math.floor(si / METRICS.length) % REGIONS.length];
      const instance = INSTANCES[si % INSTANCES.length];
      metricsUsed.add(metricName);

      const labels = new Map([
        ["__name__", metricName],
        ["region", region],
        ["instance", instance],
        ["job", "demo"],
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

    const t0 = performance.now();
    if (backendType === "column") {
      const ids = seriesData.map((sd) => store.getOrCreateSeries(sd.labels));
      for (let offset = 0; offset < numPoints; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, numPoints);
        for (let i = 0; i < seriesData.length; i++) {
          store.appendBatch(
            ids[i],
            seriesData[i].timestamps.subarray(offset, end),
            seriesData[i].values.subarray(offset, end)
          );
        }
      }
    } else {
      for (const sd of seriesData) {
        const id = store.getOrCreateSeries(sd.labels);
        store.appendBatch(id, sd.timestamps, sd.values);
      }
    }

    const ingestTime = performance.now() - t0;
    document.querySelectorAll(".scenario-card").forEach((card) => {
      card.classList.remove("active", "loading", "loaded");
    });
    onDataLoaded(store, [...metricsUsed], ingestTime, numPoints, intervalMs);
  }

  function bindCustomGenerator() {
    document.getElementById("btnCustomGenerate")?.addEventListener("click", () => {
      const numSeriesEl = document.getElementById("numSeries");
      const numPointsEl = document.getElementById("numPoints");
      const patternEl = document.getElementById("dataPattern");
      const backendType = "column";
      const intervalEl = document.getElementById("sampleInterval");
      const btn = document.getElementById("btnCustomGenerate");
      if (
        !(numSeriesEl && numPointsEl && patternEl && intervalEl && btn instanceof HTMLButtonElement)
      ) {
        return;
      }
      const numSeries = parseInt(numSeriesEl.value, 10);
      const numPoints = parseInt(numPointsEl.value, 10);
      const pattern = patternEl.value;
      const intervalMs = parseInt(intervalEl.value, 10);

      btn.disabled = true;
      btn.textContent = "Generating…";

      requestAnimationFrame(() => {
        setTimeout(() => {
          try {
            generateCustomData(numSeries, numPoints, pattern, backendType, intervalMs);
          } finally {
            btn.disabled = false;
            btn.textContent = "Generate Data";
          }
        }, 50);
      });
    });
  }

  return {
    renderScenarioCards,
    bindCustomGenerator,
  };
}
