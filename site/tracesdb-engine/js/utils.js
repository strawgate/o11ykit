// @ts-nocheck
// ── Utility Functions ─────────────────────────────────────────────────

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatBytes(b) {
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

export function formatNum(n) {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatDurationNs(ns) {
  const n = Number(ns);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}s`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}ms`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}µs`;
  return `${n}ns`;
}

export function formatDurationMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

export function formatPercent(n) {
  if (n >= 10) return `${n.toFixed(0)}%`;
  if (n >= 1) return `${n.toFixed(1)}%`;
  return `${n.toFixed(2)}%`;
}

export function hexFromBytes(buf) {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function formatHexByte(val) {
  return val.toString(16).padStart(2, "0");
}

export function shortTraceId(buf) {
  const hex = typeof buf === "string" ? buf : hexFromBytes(buf);
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

export function shortSpanId(buf) {
  const hex = typeof buf === "string" ? buf : hexFromBytes(buf);
  return hex.slice(0, 8);
}

/** Return a CSS color for a service name (deterministic hash). */
const SVC_COLORS = [
  "#06b6d4",
  "#8b5cf6",
  "#f59e0b",
  "#10b981",
  "#ec4899",
  "#3b82f6",
  "#ef4444",
  "#a3e635",
  "#f97316",
  "#14b8a6",
  "#a78bfa",
  "#fb923c",
];

export function serviceColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return SVC_COLORS[Math.abs(h) % SVC_COLORS.length];
}

/** Stable service index for CSS variable referencing */
export function serviceColorVar(name, serviceNames) {
  const idx = serviceNames.indexOf(name);
  return idx >= 0 ? `var(--svc-${idx % 12})` : serviceColor(name);
}

/** Canvas DPR setup */
export function setupCanvasDPR(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  return ctx;
}

/** Create a DOM element helper */
export function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") e.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") e.innerHTML = v;
      else e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (typeof c === "string") e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  }
  return e;
}

/** Show/hide section helpers */
export function showSection(id, scroll = false) {
  const section = document.getElementById(id);
  if (section) {
    section.hidden = false;
    if (scroll) section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

export function hideSection(id) {
  const section = document.getElementById(id);
  if (section) section.hidden = true;
}

/** Debounce */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Clamp */
export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Get service name from span */
export function spanServiceName(span) {
  if (!span.attributes) return "unknown";
  const attr = span.attributes.find((a) => a.key === "service.name");
  return attr ? attr.value : "unknown";
}

/** Get attribute value from span */
export function spanAttr(span, key) {
  if (!span.attributes) return undefined;
  const attr = span.attributes.find((a) => a.key === key);
  return attr ? attr.value : undefined;
}
