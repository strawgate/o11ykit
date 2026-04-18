// ── Chart Renderer ───────────────────────────────────────────────────

import { $, formatNum, setupCanvasDPR } from './utils.js';

export const CHART_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#e11d48', '#a855f7', '#0ea5e9', '#eab308',
];

export let lastChartState = null;
let tooltipEl = null;
let crosshairEl = null;
let tooltipController = null;

export function renderChart(canvas, seriesData, title) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.min(rect.width - 32, 1100);
  const h = 380;
  const ctx = setupCanvasDPR(canvas, w, h);

  const pad = { top: 40, right: 20, bottom: 50, left: 70 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  let minT = Infinity, maxT = -Infinity, minV = Infinity, maxV = -Infinity;
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

  if (minV === maxV) { minV -= 1; maxV += 1; }
  const vPad = (maxV - minV) * 0.08;
  minV -= vPad;
  maxV += vPad;

  const tRange = maxT - minT || 1;
  const vRange = maxV - minV || 1;

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 1;
  const yTicks = 6;
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (plotH * i / yTicks);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  const xTicks = Math.min(8, seriesData[0]?.timestamps.length || 8);
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (plotW * i / xTicks);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, h - pad.bottom);
    ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle = '#6b8a9e';
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.top + (plotH * i / yTicks);
    const val = maxV - (i / yTicks) * vRange;
    ctx.fillText(formatNum(val), pad.left - 8, y);
  }

  // X-axis labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= xTicks; i++) {
    const x = pad.left + (plotW * i / xTicks);
    const tNs = minT + (i / xTicks) * tRange;
    const tMs = tNs / 1_000_000;
    const d = new Date(tMs);
    ctx.fillText(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), x, h - pad.bottom + 8);
  }

  // Title
  ctx.fillStyle = '#0f3a5e';
  ctx.font = '600 14px "Space Grotesk", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title || 'Query Results', pad.left, 10);

  // Point count
  const totalPoints = seriesData.reduce((s, d) => s + d.timestamps.length, 0);
  ctx.fillStyle = '#6b8a9e';
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${totalPoints.toLocaleString()} points rendered`, w - pad.right, 12);

  // Draw series
  for (let si = 0; si < seriesData.length; si++) {
    const s = seriesData[si];
    const color = CHART_COLORS[si % CHART_COLORS.length];

    // Area fill
    ctx.beginPath();
    let firstX, firstY;
    for (let i = 0; i < s.timestamps.length; i++) {
      const x = pad.left + ((Number(s.timestamps[i]) - minT) / tRange) * plotW;
      const y = pad.top + ((maxV - s.values[i]) / vRange) * plotH;
      if (i === 0) { ctx.moveTo(x, y); firstX = x; firstY = y; }
      else ctx.lineTo(x, y);
    }
    if (s.timestamps.length > 0) {
      const lastX = pad.left + ((Number(s.timestamps[s.timestamps.length - 1]) - minT) / tRange) * plotW;
      ctx.lineTo(lastX, pad.top + plotH);
      ctx.lineTo(firstX, pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = color + '12';
      ctx.fill();
    }

    // Line
    ctx.beginPath();
    for (let i = 0; i < s.timestamps.length; i++) {
      const x = pad.left + ((Number(s.timestamps[i]) - minT) / tRange) * plotW;
      const y = pad.top + ((maxV - s.values[i]) / vRange) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Axes border
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, h - pad.bottom);
  ctx.lineTo(w - pad.right, h - pad.bottom);
  ctx.stroke();

  lastChartState = { seriesData, minT, maxT, minV, maxV, pad, w, h, plotW, plotH, tRange, vRange };
}

export function setupChartTooltip() {
  if (tooltipController) tooltipController.abort();
  tooltipController = new AbortController();

  const canvas = $('#chartCanvas');
  const container = canvas.closest('.chart-container');
  container.style.position = 'relative';

  if (!crosshairEl) {
    crosshairEl = document.createElement('div');
    crosshairEl.className = 'chart-crosshair';
    container.appendChild(crosshairEl);
  }
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'chart-tooltip';
    container.appendChild(tooltipEl);
  }

  const opts = { signal: tooltipController.signal };
  canvas.addEventListener('mousemove', handleChartHover, opts);
  canvas.addEventListener('mouseleave', () => {
    if (crosshairEl) crosshairEl.style.display = 'none';
    if (tooltipEl) tooltipEl.style.display = 'none';
  }, opts);
}

function handleChartHover(e) {
  if (!lastChartState || !tooltipEl || !crosshairEl) return;
  const { seriesData, minT, maxT, pad, w, h, plotW, plotH, tRange, vRange, minV, maxV } = lastChartState;
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.clientWidth / lastChartState.w;
  const scaleY = canvas.clientHeight / lastChartState.h;
  const mx = (e.clientX - rect.left) / scaleX;
  const my = (e.clientY - rect.top) / scaleY;

  if (mx < pad.left || mx > w - pad.right || my < pad.top || my > h - pad.bottom) {
    crosshairEl.style.display = 'none';
    tooltipEl.style.display = 'none';
    return;
  }

  const mouseT = minT + ((mx - pad.left) / plotW) * tRange;
  const points = [];

  for (let si = 0; si < seriesData.length; si++) {
    const s = seriesData[si];
    if (s.timestamps.length === 0) continue;
    let lo = 0, hi = s.timestamps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (Number(s.timestamps[mid]) < mouseT) lo = mid + 1; else hi = mid;
    }
    let nearest = lo;
    if (lo > 0 && Math.abs(Number(s.timestamps[lo - 1]) - mouseT) < Math.abs(Number(s.timestamps[lo]) - mouseT)) {
      nearest = lo - 1;
    }
    const labelStr = s.labels
      ? [...s.labels].filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ')
      : `series ${si}`;
    points.push({
      value: s.values[nearest],
      label: labelStr || 'all',
      color: CHART_COLORS[si % CHART_COLORS.length],
      timestamp: Number(s.timestamps[nearest]),
      y: pad.top + ((maxV - s.values[nearest]) / vRange) * plotH,
    });
  }

  if (points.length === 0) return;

  const cssLeft = mx * scaleX;
  const cssTop = pad.top * scaleY;
  const cssHeight = plotH * scaleY;
  crosshairEl.style.display = 'block';
  crosshairEl.style.left = cssLeft + 'px';
  crosshairEl.style.top = cssTop + 'px';
  crosshairEl.style.height = cssHeight + 'px';

  const time = new Date(points[0].timestamp / 1_000_000);
  let html = `<div class="tooltip-time">${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>`;
  for (const p of points) {
    html += `<div class="tooltip-row"><span class="tooltip-swatch" style="background:${p.color}"></span><span class="tooltip-label">${p.label}</span><strong>${p.value.toFixed(2)}</strong></div>`;
  }
  tooltipEl.innerHTML = html;
  tooltipEl.style.display = 'block';

  const tooltipW = tooltipEl.offsetWidth;
  const containerW = canvas.closest('.chart-container').offsetWidth;
  const left = cssLeft + 20 + tooltipW > containerW ? cssLeft - tooltipW - 12 : cssLeft + 20;
  const top = Math.max(4, (e.clientY - canvas.closest('.chart-container').getBoundingClientRect().top) - 30);
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = top + 'px';
}
