// @ts-nocheck
// ── Chart — Sparkline & bar chart renderer ─────────────────────────
import { setupCanvasDPR } from "./utils.js";

const COLORS = {
  rate: "#e85d1a",
  error: "#ef4444",
  duration: "#60a5fa",
  p50: "#10b981",
  p99: "#f59e0b",
  grid: "rgba(148, 163, 184, 0.15)",
  text: "#94a3b8",
};

/**
 * Render a sparkline into a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} values
 * @param {{ color?: string, fill?: boolean, width?: number, height?: number }} opts
 */
export function renderSparkline(canvas, values, opts = {}) {
  if (!values || values.length < 2) return;
  const w = opts.width || canvas.clientWidth || 120;
  const h = opts.height || canvas.clientHeight || 24;
  const ctx = setupCanvasDPR(canvas, w, h);
  const color = opts.color || COLORS.rate;

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = w / (values.length - 1);

  ctx.beginPath();
  ctx.moveTo(0, h - ((values[0] - min) / range) * h);
  for (let i = 1; i < values.length; i++) {
    ctx.lineTo(i * step, h - ((values[i] - min) / range) * h);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (opts.fill !== false) {
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = color.replace(")", ", 0.1)").replace("rgb", "rgba");
    ctx.fill();
  }
}

/**
 * Render a bar chart.
 * @param {HTMLCanvasElement} canvas
 * @param {{ label: string, value: number, color?: string }[]} bars
 * @param {{ width?: number, height?: number }} opts
 */
export function renderBarChart(canvas, bars, opts = {}) {
  if (!bars || bars.length === 0) return;
  const w = opts.width || canvas.clientWidth || 200;
  const h = opts.height || canvas.clientHeight || 100;
  const ctx = setupCanvasDPR(canvas, w, h);
  const padding = { top: 10, bottom: 20, left: 10, right: 10 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const max = Math.max(...bars.map((b) => b.value), 1);
  const barW = Math.min(40, (plotW / bars.length) * 0.7);
  const gap = (plotW - barW * bars.length) / (bars.length + 1);

  ctx.fillStyle = COLORS.grid;
  for (let i = 0; i < 4; i++) {
    const y = padding.top + (plotH / 3) * i;
    ctx.fillRect(padding.left, y, plotW, 1);
  }

  for (let i = 0; i < bars.length; i++) {
    const { value, color, label } = bars[i];
    const barH = (value / max) * plotH;
    const x = padding.left + gap * (i + 1) + barW * i;
    const y = padding.top + plotH - barH;

    ctx.fillStyle = color || COLORS.rate;
    ctx.beginPath();
    const r = Math.min(3, barW / 4);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, padding.top + plotH);
    ctx.lineTo(x, padding.top + plotH);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();

    ctx.fillStyle = COLORS.text;
    ctx.font = "10px var(--mono, monospace)";
    ctx.textAlign = "center";
    ctx.fillText(label, x + barW / 2, h - 4);
  }
}

export { COLORS as CHART_COLORS };
