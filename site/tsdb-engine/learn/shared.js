/**
 * Shared utilities for Learn experiences.
 * Pure functions + lightweight animation helpers — no DOM side effects on import.
 */

/** Format a number with locale-aware thousands separators. */
export function fmt(n, decimals = 0) {
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format bytes as human-readable string. */
export function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Format bits as human-readable string. */
export function fmtBits(bits) {
  if (bits < 8) return `${bits} bits`;
  if (bits < 8192) return `${(bits / 8).toFixed(1)} B`;
  return fmtBytes(bits / 8);
}

/** Convert a float64 to its IEEE 754 bit string (64 chars of 0/1). */
export function float64ToBits(value) {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = value;
  const bytes = new Uint8Array(buf);
  let bits = '';
  for (let i = 7; i >= 0; i--) {
    bits += bytes[i].toString(2).padStart(8, '0');
  }
  return bits;
}

/** Convert a BigInt (int64) to its bit string (64 chars). */
export function int64ToBits(value) {
  const big = BigInt(value);
  let s = '';
  for (let i = 63; i >= 0; i--) {
    s += (big >> BigInt(i)) & 1n ? '1' : '0';
  }
  return s;
}

/** ZigZag encode a signed value. */
export function zigzagEncode(n) {
  const big = BigInt(n);
  return big >= 0n ? big * 2n : (-big) * 2n - 1n;
}

/** ZigZag decode an unsigned value. */
export function zigzagDecode(n) {
  const big = BigInt(n);
  return (big & 1n) ? -(big >> 1n) - 1n : big >> 1n;
}

/** Count leading zero bits in a 64-bit value. */
export function clz64(value) {
  const big = BigInt(value);
  if (big === 0n) return 64;
  let count = 0;
  for (let i = 63; i >= 0; i--) {
    if ((big >> BigInt(i)) & 1n) break;
    count++;
  }
  return count;
}

/** Count trailing zero bits in a 64-bit value. */
export function ctz64(value) {
  const big = BigInt(value);
  if (big === 0n) return 64;
  let count = 0;
  for (let i = 0; i <= 63; i++) {
    if ((big >> BigInt(i)) & 1n) break;
    count++;
  }
  return count;
}

/**
 * Generate sample time-series data.
 * @param {'gauge'|'counter'|'percentage'|'temperature'|'sine'|'random'} pattern
 * @param {number} count
 * @param {object} opts
 * @returns {{ timestamps: BigInt64Array, values: Float64Array }}
 */
export function generateSamples(pattern, count, opts = {}) {
  const { interval = 15_000_000_000n, jitter = 0, base = 100, noise = 0.02 } = opts;
  const timestamps = new BigInt64Array(count);
  const values = new Float64Array(count);
  const now = BigInt(Date.now()) * 1_000_000n;

  for (let i = 0; i < count; i++) {
    const jitterNs = jitter ? BigInt(Math.round((Math.random() - 0.5) * 2 * jitter * 1e6)) : 0n;
    timestamps[i] = now - BigInt(count - i) * interval + jitterNs;

    switch (pattern) {
      case 'gauge':
        values[i] = base + Math.sin(i * 0.05) * 20 + (Math.random() - 0.5) * noise * base;
        break;
      case 'counter':
        values[i] = i === 0 ? base : values[i - 1] + Math.random() * 5 + 1;
        break;
      case 'percentage':
        values[i] = Math.round(Math.max(0, Math.min(100, 50 + Math.sin(i * 0.08) * 30 + (Math.random() - 0.5) * 10)) * 10) / 10;
        break;
      case 'temperature':
        values[i] = Math.round((20 + Math.sin(i * 0.03) * 8 + (Math.random() - 0.5) * 2) * 100) / 100;
        break;
      case 'sine':
        values[i] = Math.sin(i * 0.1) * base;
        break;
      case 'random':
        values[i] = Math.random() * base * 2;
        break;
      default:
        values[i] = base + (Math.random() - 0.5) * noise * base;
    }
  }
  return { timestamps, values };
}

/* ─── Animation Helpers ───────────────────────────────────────────── */

/** Animate a numeric value from `from` to `to` over `duration` ms, calling `cb(current)`. */
export function animateValue(from, to, duration, cb) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    cb(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/** Step-through controller for pipeline animations. */
export class Stepper {
  constructor(totalSteps, onStep) {
    this.total = totalSteps;
    this.current = -1;
    this.onStep = onStep;
    this._timer = null;
  }

  goto(step) {
    this.current = Math.max(-1, Math.min(step, this.total - 1));
    this.onStep(this.current);
  }

  next() { if (this.current < this.total - 1) this.goto(this.current + 1); }
  prev() { if (this.current > -1) this.goto(this.current - 1); }
  reset() { this.goto(-1); }

  play(intervalMs = 1200) {
    this.stop();
    this.reset();
    this._timer = setInterval(() => {
      if (this.current >= this.total - 1) { this.stop(); return; }
      this.next();
    }, intervalMs);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

/** Shorthand DOM query. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Create an element with attributes and children. */
export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  }
  return e;
}

/** Build standard breadcrumb nav for an experience page. */
export function buildBreadcrumb(title) {
  return `
    <nav class="xp-topbar" aria-label="Breadcrumb">
      <div class="xp-breadcrumb">
        <a href="../../">TSDB Engine</a>
        <span class="sep">›</span>
        <a href="../">Learn</a>
        <span class="sep">›</span>
        <span class="current">${title}</span>
      </div>
    </nav>`;
}

/** Gently reveal a section — only scrolls if not already visible, adds a brief highlight pulse. */
export function revealSection(el) {
  const rect = el.getBoundingClientRect();
  const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
  if (!inView) {
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  el.classList.add("xp-reveal");
  el.addEventListener("animationend", () => el.classList.remove("xp-reveal"), { once: true });
}

/** Render a sparkline to a canvas element. */
export function drawSparkline(canvas, values, opts = {}) {
  const { color = '#60a5fa', fillAlpha = 0.1, lineWidth = 1.5 } = opts;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (values.length < 2) return;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;

  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const x = (i / (values.length - 1)) * w;
    const y = pad + (1 - (values[i] - min) / range) * (h - 2 * pad);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();

  // fill
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = color.replace(')', `, ${fillAlpha})`).replace('rgb', 'rgba');
  ctx.fill();
}
