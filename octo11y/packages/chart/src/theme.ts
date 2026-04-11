export interface ChartTheme {
  text: string;
  mutedText: string;
  grid: string;
  border: string;
  tooltipBackground: string;
  tooltipBorder: string;
  tooltipTitle: string;
  tooltipBody: string;
}

function readCssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

export function getChartTheme(node: HTMLElement): ChartTheme {
  const style = getComputedStyle(node);
  return {
    text: readCssVar(style, "--bk-text", "#0f172a"),
    mutedText: readCssVar(style, "--bk-text-muted", "#64748b"),
    grid: readCssVar(style, "--bk-chart-grid", "rgba(148, 163, 184, 0.24)"),
    border: readCssVar(style, "--bk-border", "#cbd5e1"),
    tooltipBackground: readCssVar(style, "--bk-tooltip-bg", "#0f172a"),
    tooltipBorder: readCssVar(style, "--bk-tooltip-border", "#1e293b"),
    tooltipTitle: readCssVar(style, "--bk-tooltip-title", "#f8fafc"),
    tooltipBody: readCssVar(style, "--bk-tooltip-body", "#e2e8f0"),
  };
}
