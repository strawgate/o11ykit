// ── Chart Renderer ───────────────────────────────────────────────────

import { $, formatNum, setupCanvasDPR } from "./utils.js";

export const CHART_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
  "#f97316",
  "#6366f1",
  "#14b8a6",
  "#e11d48",
  "#a855f7",
  "#0ea5e9",
  "#eab308",
];

export let lastChartState = null;
let tooltipEl = null;
let crosshairEl = null;
let tooltipController = null;

function sampleSeriesForCanvas(series, maxSamples) {
  const count = series?.timestamps?.length || 0;
  if (count <= maxSamples || maxSamples < 8) return series;

  const targetBuckets = Math.max(4, Math.floor(maxSamples / 2));
  const bucketSize = Math.max(1, Math.ceil(count / targetBuckets));
  const timestamps = [];
  const values = [];

  for (let start = 0; start < count; start += bucketSize) {
    const end = Math.min(count, start + bucketSize);
    let minIdx = start;
    let maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      if (series.values[i] < series.values[minIdx]) minIdx = i;
      if (series.values[i] > series.values[maxIdx]) maxIdx = i;
    }

    const chosen = [...new Set([start, minIdx, maxIdx, end - 1])].sort((a, b) => a - b);
    for (const idx of chosen) {
      timestamps.push(Number(series.timestamps[idx]));
      values.push(series.values[idx]);
    }
  }

  return {
    ...series,
    timestamps,
    values,
  };
}

export function renderChart(canvas, seriesData, title, options = {}) {
  if (!canvas || !seriesData?.length) return;
  const {
    compact = false,
    showTitle = true,
    showPointCount = true,
    showXAxisLabels = true,
    showYAxisLabels = true,
    trackState = canvas?.id === "chartCanvas",
  } = options;
  const rect = canvas.parentElement.getBoundingClientRect();
  const availableWidth = Math.max(canvas.parentElement.clientWidth || 0, rect.width);
  const horizontalInset = compact ? 8 : 32;
  const w = Math.max(180, Math.min(availableWidth - horizontalInset, 1100));
  const h = Number(canvas.dataset.chartHeight) || (compact ? 220 : 380);
  const ctx = setupCanvasDPR(canvas, w, h);

  const pad = compact
    ? { top: 16, right: 10, bottom: 14, left: 14 }
    : { top: 40, right: 20, bottom: 50, left: 70 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const maxSamplesPerSeries = compact
    ? Math.max(48, Math.floor(plotW))
    : Math.max(160, Math.floor(plotW * 1.5));
  const drawSeriesData = seriesData.map((series) =>
    sampleSeriesForCanvas(series, maxSamplesPerSeries)
  );

  let minT = Infinity,
    maxT = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (const s of seriesData) {
    for (let i = 0; i < s.timestamps.length; i++) {
      const t = Number(s.timestamps[i]);
      const v = s.values[i];
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }

  if (minV === maxV) {
    minV -= 1;
    maxV += 1;
  }
  const vPad = (maxV - minV) * 0.08;
  minV = minV >= 0 ? Math.max(0, minV - vPad) : minV - vPad;
  maxV += vPad;

  const tRange = maxT - minT || 1;
  const vRange = maxV - minV || 1;

  // Background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = "rgba(0,0,0,0.06)";
  ctx.lineWidth = 1;
  const yTicks = compact ? 4 : 6;
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (plotH * i) / yTicks;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  const xTicks = compact
    ? Math.min(4, seriesData[0]?.timestamps.length || 4)
    : Math.min(8, seriesData[0]?.timestamps.length || 8);
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (plotW * i) / xTicks;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, h - pad.bottom);
    ctx.stroke();
  }

  if (showYAxisLabels) {
    ctx.fillStyle = "#6b8a9e";
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= yTicks; i++) {
      const y = pad.top + (plotH * i) / yTicks;
      const val = maxV - (i / yTicks) * vRange;
      ctx.fillText(formatNum(val), pad.left - 8, y);
    }
  }

  if (showXAxisLabels) {
    ctx.fillStyle = "#6b8a9e";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i <= xTicks; i++) {
      const x = pad.left + (plotW * i) / xTicks;
      const tNs = minT + (i / xTicks) * tRange;
      const tMs = tNs / 1_000_000;
      const d = new Date(tMs);
      ctx.fillText(
        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        x,
        h - pad.bottom + 8
      );
    }
  }

  if (showTitle) {
    ctx.fillStyle = "#0f3a5e";
    ctx.font = '600 14px "Space Grotesk", sans-serif';
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(title || "Query Results", pad.left, 10);
  }

  if (showPointCount) {
    const totalPoints = seriesData.reduce((s, d) => s + d.timestamps.length, 0);
    const drawnPoints = drawSeriesData.reduce((s, d) => s + d.timestamps.length, 0);
    ctx.fillStyle = "#6b8a9e";
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.textAlign = "right";
    const label =
      drawnPoints < totalPoints
        ? `${drawnPoints.toLocaleString()} of ${totalPoints.toLocaleString()} pts shown`
        : `${totalPoints.toLocaleString()} points rendered`;
    ctx.fillText(label, w - pad.right, 12);
  }

  // Draw series
  for (let si = 0; si < drawSeriesData.length; si++) {
    const s = drawSeriesData[si];
    const color = CHART_COLORS[si % CHART_COLORS.length];

    // Area fill
    ctx.beginPath();
    let firstX, _firstY;
    for (let i = 0; i < s.timestamps.length; i++) {
      const x = pad.left + ((Number(s.timestamps[i]) - minT) / tRange) * plotW;
      const y = pad.top + ((maxV - s.values[i]) / vRange) * plotH;
      if (i === 0) {
        ctx.moveTo(x, y);
        firstX = x;
        _firstY = y;
      } else ctx.lineTo(x, y);
    }
    if (s.timestamps.length > 0) {
      const lastX =
        pad.left + ((Number(s.timestamps[s.timestamps.length - 1]) - minT) / tRange) * plotW;
      ctx.lineTo(lastX, pad.top + plotH);
      ctx.lineTo(firstX, pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = `${color}12`;
      ctx.fill();
    }

    // Line
    ctx.beginPath();
    for (let i = 0; i < s.timestamps.length; i++) {
      const x = pad.left + ((Number(s.timestamps[i]) - minT) / tRange) * plotW;
      const y = pad.top + ((maxV - s.values[i]) / vRange) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = compact ? 1.6 : 2;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  // Axes border
  ctx.strokeStyle = "rgba(0,0,0,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, h - pad.bottom);
  ctx.lineTo(w - pad.right, h - pad.bottom);
  ctx.stroke();

  if (trackState) {
    lastChartState = {
      seriesData,
      minT,
      maxT,
      minV,
      maxV,
      pad,
      w,
      h,
      plotW,
      plotH,
      tRange,
      vRange,
    };
  }
}

export function setupChartTooltip() {
  if (tooltipController) tooltipController.abort();
  tooltipController = new AbortController();

  const canvas = $("#chartCanvas");
  const container = canvas.closest(".chart-container");
  container.style.position = "relative";

  if (!crosshairEl) {
    crosshairEl = document.createElement("div");
    crosshairEl.className = "chart-crosshair";
    container.appendChild(crosshairEl);
  }
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "chart-tooltip";
    container.appendChild(tooltipEl);
  }

  const opts = { signal: tooltipController.signal };
  canvas.addEventListener("mousemove", handleChartHover, opts);
  canvas.addEventListener(
    "mouseleave",
    () => {
      if (crosshairEl) crosshairEl.style.display = "none";
      if (tooltipEl) tooltipEl.style.display = "none";
    },
    opts
  );
}

function handleChartHover(e) {
  if (!lastChartState || !tooltipEl || !crosshairEl) return;
  const {
    seriesData,
    minT,
    maxT: _maxT,
    pad,
    w,
    h,
    plotW,
    plotH,
    tRange,
    vRange,
    minV: _minV,
    maxV,
  } = lastChartState;
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.clientWidth / lastChartState.w;
  const scaleY = canvas.clientHeight / lastChartState.h;
  const mx = (e.clientX - rect.left) / scaleX;
  const my = (e.clientY - rect.top) / scaleY;

  if (mx < pad.left || mx > w - pad.right || my < pad.top || my > h - pad.bottom) {
    crosshairEl.style.display = "none";
    tooltipEl.style.display = "none";
    return;
  }

  const mouseT = minT + ((mx - pad.left) / plotW) * tRange;
  const points = [];

  for (let si = 0; si < seriesData.length; si++) {
    const s = seriesData[si];
    if (s.timestamps.length === 0) continue;
    let lo = 0,
      hi = s.timestamps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (Number(s.timestamps[mid]) < mouseT) lo = mid + 1;
      else hi = mid;
    }
    let nearest = lo;
    if (
      lo > 0 &&
      Math.abs(Number(s.timestamps[lo - 1]) - mouseT) < Math.abs(Number(s.timestamps[lo]) - mouseT)
    ) {
      nearest = lo - 1;
    }
    const labelStr = s.labels
      ? [...s.labels]
          .filter(([k]) => k !== "__name__")
          .map(([k, v]) => `${k}="${v}"`)
          .join(", ")
      : `series ${si}`;
    points.push({
      value: s.values[nearest],
      label: labelStr || "all",
      color: CHART_COLORS[si % CHART_COLORS.length],
      timestamp: Number(s.timestamps[nearest]),
      y: pad.top + ((maxV - s.values[nearest]) / vRange) * plotH,
    });
  }

  if (points.length === 0) return;

  const cssLeft = mx * scaleX;
  const cssTop = pad.top * scaleY;
  const cssHeight = plotH * scaleY;
  crosshairEl.style.display = "block";
  crosshairEl.style.left = `${cssLeft}px`;
  crosshairEl.style.top = `${cssTop}px`;
  crosshairEl.style.height = `${cssHeight}px`;

  const time = new Date(points[0].timestamp / 1_000_000);
  let html = `<div class="tooltip-time">${time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>`;
  for (const p of points) {
    html += `<div class="tooltip-row"><span class="tooltip-swatch" style="background:${p.color}"></span><span class="tooltip-label">${p.label}</span><strong>${p.value.toFixed(2)}</strong></div>`;
  }
  tooltipEl.innerHTML = html;
  tooltipEl.style.display = "block";

  const tooltipW = tooltipEl.offsetWidth;
  const containerW = canvas.closest(".chart-container").offsetWidth;
  const left = cssLeft + 20 + tooltipW > containerW ? cssLeft - tooltipW - 12 : cssLeft + 20;
  const top = Math.max(
    4,
    e.clientY - canvas.closest(".chart-container").getBoundingClientRect().top - 30
  );
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}
