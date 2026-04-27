// @ts-nocheck
// ── Waterfall Renderer (Canvas 2D) ──────────────────────────────────
// Renders a trace as a Gantt-style waterfall chart.
// Handles both Uint8Array and string-based span IDs.
// Supports click-to-detail for span inspection.

import { formatDurationNs, hexFromBytes, serviceColor, spanServiceName } from "./utils.js";

const ROW_HEIGHT = 24;
const LABEL_WIDTH = 200;
const PADDING = 8;
const BAR_HEIGHT = 14;
const FONT_SIZE = 11;
const MAX_VISIBLE_ROWS = 200;

function spanIdStr(id) {
  if (!id) return "";
  if (typeof id === "string") return id;
  if (id instanceof Uint8Array) return hexFromBytes(id);
  return String(id);
}

/**
 * Render a trace waterfall into a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {Object} trace - { traceId, spans }
 * @param {Object} [opts]
 * @param {function} [opts.onSpanClick] - callback(span, spanIndex)
 * @returns {{ cleanup: () => void, spans: Array }}
 */
export function renderWaterfall(canvas, trace, opts = {}) {
  const { spans } = trace;
  if (!spans || spans.length === 0) return { cleanup() {}, spans: [] };

  // Sort spans: root first, then by start time
  const sorted = [...spans].sort((a, b) => {
    const aIsRoot = !a.parentSpanId;
    const bIsRoot = !b.parentSpanId;
    if (aIsRoot && !bIsRoot) return -1;
    if (!aIsRoot && bIsRoot) return 1;
    const diff = Number(a.startTimeUnixNano - b.startTimeUnixNano);
    return diff;
  });

  // Build depth map
  const spanMap = new Map();
  for (const s of sorted) {
    spanMap.set(spanIdStr(s.spanId), s);
  }

  const depthMap = new Map();
  const visiting = new Set();

  function getDepth(span) {
    const id = spanIdStr(span.spanId);
    if (depthMap.has(id)) return depthMap.get(id);
    if (!span.parentSpanId) {
      depthMap.set(id, 0);
      return 0;
    }
    if (visiting.has(id)) {
      depthMap.set(id, 0);
      return 0;
    }
    visiting.add(id);
    const parentId = spanIdStr(span.parentSpanId);
    const parent = spanMap.get(parentId);
    const d = parent ? getDepth(parent) + 1 : 0;
    visiting.delete(id);
    depthMap.set(id, d);
    return d;
  }
  for (const s of sorted) getDepth(s);

  // Tree-order sort (DFS)
  const ordered = [];
  const childrenOf = new Map();
  for (const s of sorted) {
    const parentKey = s.parentSpanId ? spanIdStr(s.parentSpanId) : "__root__";
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    childrenOf.get(parentKey).push(s);
  }

  function dfs(parentKey) {
    const children = childrenOf.get(parentKey) || [];
    children.sort((a, b) => Number(a.startTimeUnixNano - b.startTimeUnixNano));
    for (const c of children) {
      ordered.push(c);
      dfs(spanIdStr(c.spanId));
    }
  }
  dfs("__root__");

  const displaySpans = ordered.length === sorted.length ? ordered : sorted;

  // Viewport clipping for large traces
  const clipped = displaySpans.length > MAX_VISIBLE_ROWS;
  const visibleSpans = clipped ? displaySpans.slice(0, MAX_VISIBLE_ROWS) : displaySpans;

  // Time bounds
  const traceStart = visibleSpans.reduce(
    (m, s) => (s.startTimeUnixNano < m ? s.startTimeUnixNano : m),
    visibleSpans[0].startTimeUnixNano
  );
  const traceEnd = visibleSpans.reduce(
    (m, s) => (s.endTimeUnixNano > m ? s.endTimeUnixNano : m),
    visibleSpans[0].endTimeUnixNano
  );
  const totalDuration = Number(traceEnd - traceStart) || 1;

  // Canvas sizing
  const dpr = window.devicePixelRatio || 1;
  let canvasWidth = canvas.parentElement?.clientWidth || 800;
  const canvasHeight = visibleSpans.length * ROW_HEIGHT + PADDING * 2;

  function sizeCanvas() {
    canvasWidth = canvas.parentElement?.clientWidth || 800;
    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;
    const ctx2 = canvas.getContext("2d");
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeCanvas();

  const ctx = canvas.getContext("2d");
  let barAreaWidth = canvasWidth - LABEL_WIDTH - PADDING * 2;
  let selectedIndex = -1;

  function draw(hoverIndex = -1) {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Background
    ctx.fillStyle = "#0a1929";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Time grid
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
      const x = LABEL_WIDTH + PADDING + (barAreaWidth * i) / gridLines;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasHeight);
      ctx.stroke();
    }

    // Time labels
    ctx.font = `${FONT_SIZE - 1}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = "#64748b";
    ctx.textAlign = "center";
    for (let i = 0; i <= gridLines; i++) {
      const x = LABEL_WIDTH + PADDING + (barAreaWidth * i) / gridLines;
      const ns = (totalDuration * i) / gridLines;
      ctx.fillText(formatDurationNs(BigInt(Math.round(ns))), x, 10);
    }

    // Rows
    for (let i = 0; i < visibleSpans.length; i++) {
      const span = visibleSpans[i];
      const y = PADDING + i * ROW_HEIGHT;
      const depth = depthMap.get(spanIdStr(span.spanId)) || 0;

      // Selection highlight
      if (i === selectedIndex) {
        ctx.fillStyle = "rgba(232, 93, 26, 0.12)";
        ctx.fillRect(0, y, canvasWidth, ROW_HEIGHT);
      } else if (i === hoverIndex) {
        ctx.fillStyle = "rgba(59, 130, 246, 0.08)";
        ctx.fillRect(0, y, canvasWidth, ROW_HEIGHT);
      }

      // Color
      const svcName = spanServiceName(span);
      const color = serviceColor(svcName);

      // Label
      ctx.font = `${FONT_SIZE}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = "#94a3b8";
      ctx.textAlign = "left";
      const indent = Math.min(depth * 2, 12);
      const label = `${"  ".repeat(indent)}${span.name}`;
      const maxLabelWidth = LABEL_WIDTH - 8;
      ctx.fillText(truncateText(ctx, label, maxLabelWidth), 4, y + ROW_HEIGHT / 2 + 4);

      // Bar
      const spanStart = Number(span.startTimeUnixNano - traceStart);
      const spanDurNanos =
        span.durationNanos != null
          ? span.durationNanos
          : span.endTimeUnixNano - span.startTimeUnixNano;
      const spanDur = Number(spanDurNanos);
      const barX = LABEL_WIDTH + PADDING + (spanStart / totalDuration) * barAreaWidth;
      const barW = Math.max(2, (spanDur / totalDuration) * barAreaWidth);
      const barY = y + (ROW_HEIGHT - BAR_HEIGHT) / 2;

      ctx.fillStyle = span.statusCode === 2 ? "#ef4444" : color;
      ctx.beginPath();
      roundRect(ctx, barX, barY, barW, BAR_HEIGHT, 3);
      ctx.fill();

      // Duration on bar
      if (barW > 50) {
        ctx.font = `${FONT_SIZE - 1}px "IBM Plex Mono", monospace`;
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.fillText(formatDurationNs(spanDur), barX + 4, barY + BAR_HEIGHT - 3);
      }
    }

    // Clipped indicator
    if (clipped) {
      ctx.fillStyle = "rgba(148, 163, 184, 0.6)";
      ctx.font = `${FONT_SIZE}px "IBM Plex Mono", monospace`;
      ctx.textAlign = "center";
      ctx.fillText(
        `… ${displaySpans.length - MAX_VISIBLE_ROWS} more spans`,
        canvasWidth / 2,
        canvasHeight - 4
      );
    }
  }

  draw();

  // Interaction
  let currentHover = -1;

  function getSpanAtY(clientY) {
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const idx = Math.floor((y - PADDING) / ROW_HEIGHT);
    return idx >= 0 && idx < visibleSpans.length ? idx : -1;
  }

  function onMouseMove(e) {
    const idx = getSpanAtY(e.clientY);
    if (idx !== currentHover) {
      currentHover = idx;
      draw(idx);
      canvas.style.cursor = idx >= 0 ? "pointer" : "default";
    }
  }

  function onClick(e) {
    const idx = getSpanAtY(e.clientY);
    if (idx >= 0) {
      selectedIndex = idx;
      draw(idx);
      if (opts.onSpanClick) opts.onSpanClick(visibleSpans[idx], idx);
    }
  }

  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("click", onClick);

  let resizeObserver;
  if (typeof ResizeObserver !== "undefined" && canvas.parentElement) {
    resizeObserver = new ResizeObserver(() => {
      sizeCanvas();
      barAreaWidth = canvasWidth - LABEL_WIDTH - PADDING * 2;
      draw(currentHover);
    });
    resizeObserver.observe(canvas.parentElement);
  }

  return {
    cleanup() {
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("click", onClick);
      if (resizeObserver) resizeObserver.disconnect();
    },
    spans: displaySpans,
  };
}

function truncateText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 3 && ctx.measureText(`${t}…`).width > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}…`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

/**
 * Build the service legend below the waterfall.
 */
export function renderLegend(container, serviceNames) {
  container.innerHTML = "";
  for (const name of serviceNames) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = serviceColor(name);
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(name));
    container.appendChild(item);
  }
  container.hidden = false;
}
