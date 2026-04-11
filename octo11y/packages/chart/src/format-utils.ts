/**
 * Shared formatting utilities used across chart components.
 */

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * Format a numeric value for display.
 *
 * When `compact` is true, large numbers are abbreviated (e.g. 1.2K).
 * Otherwise values ≥ 100 show no decimals, smaller values show up to 2.
 */
export function formatValue(value: number, compact = false): string {
  if (compact) return compactFormatter.format(value);
  return value.toLocaleString("en-US", {
    maximumFractionDigits: value >= 100 ? 0 : 2,
  });
}

/**
 * Format a numeric value with fixed decimal places.
 *
 * Integers get no decimals, values ≥ 100 get 1 decimal, others get 2.
 * Unlike {@link formatValue} this uses `toFixed` so trailing zeros are
 * preserved (useful in tabular data where column alignment matters).
 */
export function formatFixedValue(value: number): string {
  if (Number.isInteger(value)) return value.toFixed(0);
  if (Math.abs(value) >= 100) return value.toFixed(1);
  return value.toFixed(2);
}

/**
 * Format a git ref for human-readable display.
 *
 * Strips common prefixes (`refs/heads/`, `refs/tags/`, `refs/pull/…/merge`)
 * and returns a short label. Returns `"—"` for undefined/empty refs.
 */
export function formatRef(ref: string | undefined): string {
  if (!ref) return "—";
  const prMatch = /^refs\/pull\/(\d+)\/merge$/.exec(ref);
  if (prMatch) return `PR #${prMatch[1]}`;
  if (ref.startsWith("refs/heads/")) return ref.replace("refs/heads/", "");
  if (ref.startsWith("refs/tags/"))
    return `tag ${ref.replace("refs/tags/", "")}`;
  return ref;
}

/**
 * Format a percentage change with sign.
 *
 * Positive values get a `+` prefix, negative values keep their `-`.
 */
export function formatPct(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Format a run timestamp for compact UI display.
 *
 * Returns the original input when it is not a valid date string.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format a commit SHA as a short display-friendly hash.
 *
 * Returns an en dash when no commit is available.
 */
export function shortCommit(commit?: string): string {
  return commit ? commit.slice(0, 7) : "–";
}

/**
 * Format metric direction semantics for human-readable UI copy.
 */
export function formatDirection(direction: string): string {
  if (direction === "smaller_is_better") {
    return "↓ smaller";
  }

  if (direction === "bigger_is_better") {
    return "↑ bigger";
  }

  return direction ? `? ${direction}` : "unknown";
}
