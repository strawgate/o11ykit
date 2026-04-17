// ── Utility Functions ─────────────────────────────────────────────────

export const $ = (sel) => document.querySelector(sel);

export function formatBytes(b) {
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

export function formatNum(n) {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  if (Math.abs(n) < 0.01 && n !== 0) return n.toExponential(1);
  return n.toFixed(1);
}

export function formatDuration(ms) {
  if (ms >= 86400000) return (ms / 86400000) + 'd';
  if (ms >= 3600000) return (ms / 3600000) + 'h';
  if (ms >= 60000) return (ms / 60000) + 'm';
  return (ms / 1000) + 's';
}

export function formatTimeRange(nsStart, nsEnd) {
  const start = new Date(Number(nsStart) / 1_000_000);
  const end = new Date(Number(nsEnd) / 1_000_000);
  const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return `${start.toLocaleString([], opts)} → ${end.toLocaleString([], opts)}`;
}

export function autoSelectQueryStep(intervalMs, numPoints) {
  const totalMs = intervalMs * numPoints;
  const stepSelect = $('#queryStep');
  const targetBuckets = 100;
  const idealStepMs = totalMs / targetBuckets;
  const stepOptions = [...stepSelect.options].map(o => parseInt(o.value)).filter(v => v > 0);
  let bestStep = stepOptions[0];
  let bestDiff = Infinity;
  for (const s of stepOptions) {
    const diff = Math.abs(s - idealStepMs);
    if (diff < bestDiff) { bestDiff = diff; bestStep = s; }
  }
  stepSelect.value = String(bestStep);
}

// Binary search helpers
export function lowerBound(arr, target, lo, hi) {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function upperBound(arr, target, lo, hi) {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Byte-level helpers
export function readI64BE(buf, offset) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return dv.getBigInt64(offset, false);
}

export function readF64BE(buf, offset) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return dv.getFloat64(offset, false);
}

export function formatEpochNs(ns) {
  try {
    return new Date(Number(ns / 1_000_000n)).toISOString();
  } catch (_) {
    return ns.toString();
  }
}

export function superNum(n) {
  const sup = '\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079';
  return String(n).split('').map(c => sup[parseInt(c)] || c).join('');
}
