// @ts-nocheck
// ── Waterfall Renderer (Canvas 2D) ──────────────────────────────────
// Renders a trace as a Gantt-style waterfall chart.

import { formatDurationNs, hexFromBytes, serviceColor } from "./utils.js";

const ROW_HEIGHT = 24;
const LABEL_WIDTH = 200;
const PADDING = 8;
const BAR_HEIGHT = 14;
const FONT_SIZE = 11;

/**
 * Render a trace waterfall into a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {Object} trace - { traceId, spans, rootSpan, durationNanos }
 * @param {Object} [opts]
 * @param {function} [opts.onSpanClick] - callback(spanIndex)
 * @returns {{ cleanup: () => void }}
 */
export function renderWaterfall(canvas, trace, opts = {}) {
  const { spans } = trace;
  if (!spans || spans.length === 0) return { cleanup() {} };

  // Sort spans: root first, then by start time
  const sorted = [...spans].sort((a, b) => {
    if (!a.parentSpanId && b.parentSpanId) return -1;
    if (a.parentSpanId && !b.parentSpanId) return 1;
    const diff = Number(a.startTimeUnixNano - b.startTimeUnixNano);
    return diff;
  });

  // Build depth map for indentation
  const spanMap = new Map();
  for (const s of sorted) {
    spanMap.set(hexFromBytes(s.spanId), s);
  }

  const depthMap = new Map();
  const visiting = new Set();
  function getDepth(span) {
    const id = hexFromBytes(span.spanId);
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
    const parentHex = hexFromBytes(span.parentSpanId);
    const parent = spanMap.get(parentHex);
    const d = parent ? getDepth(parent) + 1 : 0;
    visiting.delete(id);
    depthMap.set(id, d);
    return d;
  }
  for (const s of sorted) getDepth(s);

  // Re-sort by tree order (DFS)
  const ordered = [];
  const childrenOf = new Map();
  for (const s of sorted) {
    const parentHex = s.parentSpanId ? hexFromBytes(s.parentSpanId) : "__root__";
    if (!childrenOf.has(parentHex)) childrenOf.set(parentHex, []);
    childrenOf.get(parentHex).push(s);
  }

  function dfs(parentKey) {
    const children = childrenOf.get(parentKey) || [];
    children.sort((a, b) => Number(a.startTimeUnixNano - b.startTimeUnixNano));
    for (const c of children) {
      ordered.push(c);
      dfs(hexFromBytes(c.spanId));
    }
  }
  dfs("__root__");

  // If DFS didn't capture all (broken parent refs), just use sorted
  const displaySpans = ordered.length === sorted.length ? ordered : sorted;

  // Calculate time bounds
  const traceStart = displaySpans.reduce(
    (m, s) => (s.startTimeUnixNano < m ? s.startTimeUnixNano : m),
    displaySpans[0].startTimeUnixNano
  );
  const traceEnd = displaySpans.reduce(
    (m, s) => (s.endTimeUnixNano > m ? s.endTimeUnixNano : m),
    displaySpans[0].endTimeUnixNano
  );
  const totalDuration = Number(traceEnd - traceStart) || 1; // guard div-by-zero for instant spans

  // Canvas sizing
  const dpr = window.devicePixelRatio || 1;
  let canvasWidth = canvas.parentElement.clientWidth || 800;
  const canvasHeight = displaySpans.length * ROW_HEIGHT + PADDING * 2;

  function sizeCanvas() {
    canvasWidth = canvas.parentElement.clientWidth || 800;
    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;
    const ctx2 = canvas.getContext("2d");
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeCanvas();

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  let barAreaWidth = canvasWidth - LABEL_WIDTH - PADDING * 2;

  // Draw
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

    // Time labels at top
    ctx.font = `${FONT_SIZE - 1}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = "#64748b";
    ctx.textAlign = "center";
    for (let i = 0; i <= gridLines; i++) {
      const x = LABEL_WIDTH + PADDING + (barAreaWidth * i) / gridLines;
      const ns = (totalDuration * i) / gridLines;
      ctx.fillText(formatDurationNs(BigInt(Math.round(ns))), x, 10);
    }

    // Rows
    for (let i = 0; i < displaySpans.length; i++) {
      const span = displaySpans[i];
      const y = PADDING + i * ROW_HEIGHT;
      const depth = depthMap.get(hexFromBytes(span.spanId)) || 0;

      // Hover highlight
      if (i === hoverIndex) {
        ctx.fillStyle = "rgba(59, 130, 246, 0.08)";
        ctx.fillRect(0, y, canvasWidth, ROW_HEIGHT);
      }

      // Service color
      const svcAttr = span.attributes?.find((a) => a.key === "service.name");
      const svcName = svcAttr?.value || "unknown";
      const color = serviceColor(svcName);

      // Label (indented by depth)
      ctx.font = `${FONT_SIZE}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = "#94a3b8";
      ctx.textAlign = "left";
      const label = `${"  ".repeat(depth)}${span.name}`;
      const maxLabelWidth = LABEL_WIDTH - 8;
      const truncLabel = truncateText(ctx, label, maxLabelWidth);
      ctx.fillText(truncLabel, 4, y + ROW_HEIGHT / 2 + 4);

      // Bar
      const spanStart = Number(span.startTimeUnixNano - traceStart);
      const spanDur = Number(span.durationNanos || span.endTimeUnixNano - span.startTimeUnixNano);
      const barX = LABEL_WIDTH + PADDING + (spanStart / totalDuration) * barAreaWidth;
      const barW = Math.max(2, (spanDur / totalDuration) * barAreaWidth);
      const barY = y + (ROW_HEIGHT - BAR_HEIGHT) / 2;

      ctx.fillStyle = span.statusCode === 2 ? "#ef4444" : color;
      ctx.beginPath();
      roundRect(ctx, barX, barY, barW, BAR_HEIGHT, 3);
      ctx.fill();

      // Duration label on bar (if fits)
      if (barW > 50) {
        ctx.font = `${FONT_SIZE - 1}px "IBM Plex Mono", monospace`;
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.fillText(formatDurationNs(span.durationNanos), barX + 4, barY + BAR_HEIGHT - 3);
      }
    }
  }

  draw();

  // Interaction
  let currentHover = -1;
  function getSpanAtY(clientY) {
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const idx = Math.floor((y - PADDING) / ROW_HEIGHT);
    return idx >= 0 && idx < displaySpans.length ? idx : -1;
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
    if (idx >= 0 && opts.onSpanClick) {
      opts.onSpanClick(displaySpans[idx], idx);
    }
  }

  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("click", onClick);

  // Re-render on container resize
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
 * @param {HTMLElement} container
 * @param {string[]} serviceNames
 */
export function renderLegend(container, serviceNames) {
  container.innerHTML = "";
  for (const name of serviceNames) {
    const el = document.createElement("div");
    el.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = serviceColor(name);
    el.appendChild(swatch);
    el.appendChild(document.createTextNode(name));
    container.appendChild(el);
  }
  container.hidden = false;
}
