// @ts-nocheck
// ── Utility Functions ─────────────────────────────────────────────────

export const $ = (sel) => document.querySelector(sel);

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatBytes(b) {
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

export function hexFromBytes(buf) {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function shortTraceId(buf) {
  const hex = hexFromBytes(buf);
  return hex.slice(0, 8) + "…" + hex.slice(-4);
}

/** Return a CSS color for a service name (deterministic hash). */
const SVC_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16",
];

export function serviceColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return SVC_COLORS[Math.abs(h) % SVC_COLORS.length];
}
