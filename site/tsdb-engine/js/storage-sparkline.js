import { formatEpochNs, formatNum, setupCanvasDPR } from "./utils.js";

const sparklineState = new WeakMap();

export function renderSparkline(canvasId, decoded) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  let state = sparklineState.get(canvas);
  if (!state) {
    state = {
      hoverIndex: null,
      redraw: null,
      bound: false,
      pointCount: 0,
    };
    sparklineState.set(canvas, state);
  }

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const pickDimensions = () => {
    const rect = canvas.getBoundingClientRect();
    const attrW = Number(canvas.getAttribute("width")) || 600;
    const attrH = Number(canvas.getAttribute("height")) || 140;
    return {
      w: Math.max(260, Math.round(rect.width || canvas.clientWidth || attrW)),
      h: Math.max(120, Math.round(rect.height || canvas.clientHeight || attrH)),
    };
  };

  const values = decoded.values;
  const n = values.length;
  const timestamps = decoded.timestamps || [];
  state.pointCount = n;
  if (n === 0) {
    const { w, h } = pickDimensions();
    const ctx = setupCanvasDPR(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    state.hoverIndex = null;
    return;
  }

  const draw = () => {
    const { w, h } = pickDimensions();
    const ctx = setupCanvasDPR(canvas, w, h);
    ctx.clearRect(0, 0, w, h);

    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      if (values[i] < minV) minV = values[i];
      if (values[i] > maxV) maxV = values[i];
    }
    if (minV === maxV) {
      minV -= 1;
      maxV += 1;
    }
    const valuePadding = (maxV - minV) * 0.08 || 1;
    minV -= valuePadding;
    maxV += valuePadding;
    const vRange = maxV - minV;

    const left = 14;
    const right = 12;
    const top = 12;
    const bottom = 18;
    const plotLeft = left;
    const plotTop = top;
    const plotRight = w - right;
    const plotBottom = h - bottom;
    const plotW = Math.max(1, plotRight - plotLeft);
    const plotH = Math.max(1, plotBottom - plotTop);

    const xAt = (index) => {
      if (n <= 1) return plotLeft + plotW / 2;
      return plotLeft + (index / (n - 1)) * plotW;
    };
    const yAt = (value) => clamp(plotTop + ((maxV - value) / vRange) * plotH, plotTop, plotBottom);

    ctx.fillStyle = "rgba(247, 251, 255, 0.96)";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(15, 58, 94, 0.08)";
    ctx.lineWidth = 1;
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const y = plotTop + (i / yTicks) * plotH;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
    }
    const xTicks = Math.min(6, Math.max(2, n - 1));
    for (let i = 0; i <= xTicks; i++) {
      const x = plotLeft + (i / xTicks) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(15, 58, 94, 0.18)";
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotTop);
    ctx.lineTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.stroke();

    const grad = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
    grad.addColorStop(0, "rgba(59, 130, 246, 0.18)");
    grad.addColorStop(1, "rgba(59, 130, 246, 0.02)");

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = clamp(xAt(i), plotLeft, plotRight);
      const y = yAt(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(clamp(xAt(n - 1), plotLeft, plotRight), plotBottom);
    ctx.lineTo(clamp(xAt(0), plotLeft, plotRight), plotBottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = clamp(xAt(i), plotLeft, plotRight);
      const y = yAt(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.75;
    ctx.stroke();

    if (state.hoverIndex !== null && state.hoverIndex >= 0 && state.hoverIndex < n) {
      const idx = state.hoverIndex;
      const x = clamp(xAt(idx), plotLeft, plotRight);
      const y = yAt(values[idx]);

      ctx.strokeStyle = "rgba(15, 58, 94, 0.24)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#2563eb";
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.stroke();

      const tooltipLines = [`Value: ${formatNum(values[idx])}`];
      if (timestamps[idx] !== undefined) tooltipLines.push(formatEpochNs(timestamps[idx]));

      ctx.font = '12px "IBM Plex Mono", monospace';
      const tooltipW = Math.max(...tooltipLines.map((line) => ctx.measureText(line).width)) + 18;
      const tooltipH = tooltipLines.length * 16 + 12;
      const tooltipX = clamp(x + 10, plotLeft + 6, plotRight - tooltipW - 4);
      const tooltipY = y < plotTop + 34 ? y + 10 : y - tooltipH - 10;

      ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
      ctx.beginPath();
      ctx.roundRect(tooltipX, tooltipY, tooltipW, tooltipH, 8);
      ctx.fill();

      ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
      tooltipLines.forEach((line, lineIndex) => {
        ctx.fillText(line, tooltipX + 9, tooltipY + 18 + lineIndex * 16);
      });
    }
  };

  state.redraw = draw;
  draw();

  if (!state.bound) {
    state.bound = true;
    canvas.addEventListener("mousemove", (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const usableWidth = Math.max(1, rect.width - 26);
      const relative = clamp((x - 14) / usableWidth, 0, 1);
      state.hoverIndex = Math.round(relative * Math.max(0, state.pointCount - 1));
      state.redraw?.();
    });
    canvas.addEventListener("mouseleave", () => {
      state.hoverIndex = null;
      state.redraw?.();
    });
  }
}
