import { renderChart } from "./chart.js";
import { escapeHtml } from "./utils.js";

export function createMetricsExplorerController({
  getMetrics,
  getMetricMeta,
  buildOverviewConfig,
  buildDimensionViews,
  executeQuery,
  formatMetricName,
  openQueryConfig,
}) {
  let activeMetric = null;
  let populated = false;
  let overviewCache = null;
  let galleryCache = new Map();

  const overviewStage = document.getElementById("metricsOverviewStage");
  const galleryStage = document.getElementById("metricsGalleryStage");
  const overviewGrid = document.getElementById("metricsOverviewGrid");
  const galleryGrid = document.getElementById("metricsGalleryGrid");
  const galleryIntro = document.getElementById("metricsGalleryIntro");
  const galleryStats = document.getElementById("metricsGalleryStats");
  const backButton = document.getElementById("metricsBackButton");

  backButton?.addEventListener("click", () => {
    activeMetric = null;
    render();
  });

  function reset() {
    populated = false;
    activeMetric = null;
    overviewCache = null;
    galleryCache = new Map();
    overviewGrid?.replaceChildren();
    galleryGrid?.replaceChildren();
    if (galleryStats) galleryStats.innerHTML = "";
    if (backButton) backButton.hidden = true;
  }

  function estimateGridPointBudget(grid, minCardWidth, fallback) {
    if (!grid) return fallback;
    const gridWidth = grid.clientWidth || grid.getBoundingClientRect().width || 0;
    if (gridWidth <= 0) return fallback;

    const styles = getComputedStyle(grid);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || "0") || 0;
    const columns = Math.max(1, Math.floor((gridWidth + gap) / (minCardWidth + gap)));
    const cardWidth = Math.max(180, (gridWidth - gap * (columns - 1)) / columns);
    return Math.max(64, Math.floor(cardWidth - 32));
  }

  function setStage(mode) {
    const showGallery = mode === "gallery";
    if (overviewStage) overviewStage.hidden = showGallery;
    if (galleryStage) galleryStage.hidden = !showGallery;
    if (showGallery) {
      overviewGrid?.replaceChildren();
    } else {
      galleryGrid?.replaceChildren();
      if (galleryStats) galleryStats.innerHTML = "";
      if (backButton) backButton.hidden = true;
    }
  }

  function buildOverviewCards(force = false, maxPoints) {
    if (!force && overviewCache?.budget === maxPoints) return overviewCache.cards;
    const cards = [];
    for (const metric of getMetrics()) {
      const meta = getMetricMeta(metric);
      const execution = executeQuery(buildOverviewConfig(meta), { maxPoints });
      if (!execution) continue;
      cards.push({ meta, execution });
    }
    overviewCache = { budget: maxPoints, cards };
    return cards;
  }

  function buildGalleryCards(meta, force = false, maxPoints) {
    if (!meta) return [];
    const cached = galleryCache.get(meta.metric);
    if (!force && cached?.budget === maxPoints) return cached.cards;

    const cards = [];
    for (const view of buildDimensionViews(meta)) {
      const execution = executeQuery(view.config, { maxPoints });
      if (!execution) continue;
      cards.push({ view, execution });
    }
    galleryCache.set(meta.metric, { budget: maxPoints, cards });
    return cards;
  }

  function renderOverview() {
    if (!overviewGrid) return;

    setStage("overview");
    const maxPoints = estimateGridPointBudget(overviewGrid, 260, 180);
    const cards = buildOverviewCards(false, maxPoints);

    if (cards.length === 0) {
      overviewGrid.innerHTML =
        '<div class="metrics-empty">Load a dataset to start exploring metrics.</div>';
      return;
    }

    overviewGrid.innerHTML = "";
    const renderQueue = [];
    for (const { meta, execution } of cards) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "metrics-overview-card";
      card.innerHTML = `
        <div class="metrics-overview-head">
          <div class="metrics-overview-title">${escapeHtml(meta.metric)}</div>
          <div class="metrics-overview-meta">${meta.seriesCount.toLocaleString()} series · ${meta.counterLike ? "counter-style" : "gauge-style"}</div>
        </div>
        <div class="metrics-overview-chart">
          <canvas width="1100" height="160" data-chart-height="160"></canvas>
        </div>
      `;
      overviewGrid.appendChild(card);
      renderQueue.push({
        canvas: card.querySelector("canvas"),
        series: execution.result.series,
      });
      card.addEventListener("click", () => {
        activeMetric = meta.metric;
        renderGallery();
      });
    }

    requestAnimationFrame(() => {
      for (const { canvas, series } of renderQueue) {
        renderChart(canvas, series, "", {
          compact: true,
          showTitle: false,
          showPointCount: false,
          showXAxisLabels: false,
          showYAxisLabels: false,
        });
      }
    });
  }

  function renderGallery() {
    if (!galleryGrid || !galleryIntro || !galleryStats) return;
    if (!activeMetric) {
      renderOverview();
      return;
    }

    setStage("gallery");
    if (backButton) backButton.hidden = false;

    const meta = getMetricMeta(activeMetric);
    const views = buildDimensionViews(meta);
    galleryIntro.textContent = `Showing ${formatMetricName(meta.metric)} as one chart per available dimension discovered in this dataset. Click any chart to open that split in Query Builder.`;
    galleryStats.innerHTML = `
      <span>${formatMetricName(meta.metric)}</span>
      <span>${meta.seriesCount.toLocaleString()} input series</span>
      <span>${Math.max(views.length - 1, 0).toLocaleString()} dimensions</span>
    `;
    galleryGrid.innerHTML = "";

    const maxPoints = estimateGridPointBudget(galleryGrid, 300, 140);
    const cards = buildGalleryCards(meta, false, maxPoints);

    if (cards.length === 0) {
      galleryGrid.innerHTML =
        '<div class="metrics-empty">No charts could be rendered for this metric.</div>';
      return;
    }

    const renderQueue = [];
    for (const { view, execution } of cards) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "metrics-gallery-card";
      card.innerHTML = `
        <div class="metrics-gallery-label">${escapeHtml(view.title)}</div>
        <div class="metrics-gallery-chart">
          <canvas width="1100" height="120" data-chart-height="120"></canvas>
        </div>
      `;

      galleryGrid.appendChild(card);
      renderQueue.push({
        canvas: card.querySelector("canvas"),
        series: execution.result.series,
      });
      card.addEventListener("click", () => openQueryConfig(view.config));
    }

    requestAnimationFrame(() => {
      for (const { canvas, series } of renderQueue) {
        renderChart(canvas, series, "", {
          compact: true,
          showTitle: false,
          showPointCount: false,
          showXAxisLabels: false,
          showYAxisLabels: false,
        });
      }
    });
  }

  function render() {
    populated = true;
    if (activeMetric) renderGallery();
    else renderOverview();
  }

  function handleResize() {
    if (!populated) return;
    if (activeMetric) renderGallery();
    else renderOverview();
  }

  return {
    get activeMetric() {
      return activeMetric;
    },
    get isPopulated() {
      return populated;
    },
    reset,
    render,
    handleResize,
  };
}
