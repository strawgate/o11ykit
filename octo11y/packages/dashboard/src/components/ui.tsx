import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { T } from "../tokens";
import type { Route } from "../router";

/* ── Layout ─────────────────────────────────────────────── */

export function Shell(props: {
  route: Route;
  go: (r: Route) => void;
  children: ComponentChildren;
}) {
  const tabs: Array<{ route: Route; label: string }> = [
    { route: { page: "guide" }, label: "Overview" },
    { route: { page: "benchstory" }, label: "Benchkit" },
    { route: { page: "custom" }, label: "Custom" },
    { route: { page: "docs" }, label: "Docs" },
  ];

  const isActive = (tab: Route) => {
    if (tab.page === "guide") return props.route.page === "guide";
    if (tab.page === "benchstory") {
      return props.route.page === "benchstory"
        || props.route.page === "benchmarks"
        || props.route.page === "benchmark"
        || props.route.page === "metric"
        || props.route.page === "run";
    }
    if (tab.page === "custom") return props.route.page === "custom";
    if (tab.page === "docs") return props.route.page === "docs";
    return false;
  };

  return (
    <>
      <style>{`*, *::before, *::after { box-sizing: border-box; min-width: 0; }`}</style>
      <div style={{ minHeight: "100vh", background: T.bgPage, fontFamily: T.font, color: T.textPrimary }}>
        <header style={{ background: `linear-gradient(180deg, ${T.bgHeaderTop}e6 0%, ${T.bgHeaderBot}e6 100%)`, borderBottom: "1px solid #30363d", position: "sticky", top: "0", zIndex: "100", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}>
          <div style={{ maxWidth: T.maxW, margin: "0 auto", padding: "16px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
            <div style={{ cursor: "pointer" }} onClick={() => props.go({ page: "guide" })}>
              <h1 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 600, color: T.textOnDark }}>
                Octo11y
              </h1>
              <p style={{ margin: "2px 0 0", fontSize: "0.75rem", color: T.textSubtleOnDark }}>
                Observability for GitHub Actions
              </p>
            </div>
            <nav style={{ display: "flex", gap: "4px" }}>
              {tabs.map((tab) => {
                const active = isActive(tab.route);
                return (
                  <button
                    key={tab.label}
                    onClick={() => props.go(tab.route)}
                    style={{
                      border: "none",
                      background: active ? "rgba(47,129,247,0.15)" : "transparent",
                      color: active ? T.blue : T.textSubtleOnDark,
                      padding: "6px 12px",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      fontFamily: T.font,
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </nav>
          </div>
        </header>
        <main id="main-content" style={{ maxWidth: (props.route.page === "guide" || props.route.page === "benchstory" || props.route.page === "custom" || props.route.page === "docs") ? "none" : T.maxW, margin: "0 auto", padding: (props.route.page === "guide" || props.route.page === "benchstory" || props.route.page === "custom" || props.route.page === "docs") ? "0" : "24px 16px" }}>
          {props.children}
        </main>
      </div>
    </>
  );
}

/* ── Primitives ─────────────────────────────────────────── */

export function Breadcrumb(props: { items: Array<{ label: string; route?: Route }>; go: (r: Route) => void }) {
  return (
    <nav style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.8rem", color: T.textMuted, marginBottom: "16px", flexWrap: "wrap" }}>
      {props.items.map((item, i) => (
        <span key={i}>
          {i > 0 && <span style={{ margin: "0 2px" }}>/</span>}
          {item.route ? (
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); props.go(item.route!); }}
              style={{ color: T.blue, textDecoration: "none" }}
            >
              {item.label}
            </a>
          ) : (
            <span style={{ color: T.textPrimary, fontWeight: 600 }}>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function StatPill(props: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      background: T.bgCard,
      border: `1px solid ${T.border}`,
      borderRadius: "20px",
      padding: "4px 12px 4px 10px",
      fontSize: "0.78rem",
    }}>
      {props.color && <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: props.color, flexShrink: 0 }} />}
      <span style={{ color: T.textSecondary }}>{props.label}</span>
      <span style={{ fontWeight: 700, color: T.textPrimary }}>{props.value}</span>
    </div>
  );
}

export function Card(props: { children: ComponentChildren; onClick?: () => void; borderColor?: string; style?: Record<string, string> }) {
  const interactive = !!props.onClick;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={props.onClick}
      onKeyDown={interactive ? (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onClick!(); } } : undefined}
      style={{
        background: T.bgCard,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        padding: "16px",
        boxShadow: T.shadow,
        cursor: interactive ? "pointer" : "default",
        borderTop: props.borderColor ? `3px solid ${props.borderColor}` : undefined,
        transition: interactive ? "box-shadow 0.15s, border-color 0.15s" : undefined,
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}

export function SectionHeading(props: { title: string; subtitle?: string; right?: ComponentChildren }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600, color: T.textPrimary }}>{props.title}</h2>
        {props.subtitle && <p style={{ margin: "4px 0 0", fontSize: "0.85rem", color: T.textSecondary }}>{props.subtitle}</p>}
      </div>
      {props.right}
    </div>
  );
}

export function EmptyState(props: { title: string; body: string }) {
  return (
    <div style={{ textAlign: "center" as const, padding: "48px 16px", color: T.textMuted }}>
      <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600, color: T.textSecondary }}>{props.title}</h3>
      <p style={{ margin: "8px 0 0", fontSize: "0.85rem" }}>{props.body}</p>
    </div>
  );
}

/* ── Visualisation helpers ──────────────────────────────── */

let _spId = 0;
export function Sparkline(props: { points: Array<{ v: number }>; width?: number; height?: number; color?: string; filled?: boolean }) {
  const { width = 200, height = 40, color = T.blue, filled = false } = props;
  const [gradId] = useState(() => `sp${++_spId}`);
  const vals = props.points.map(p => p.v);
  if (vals.length === 0) return null;

  /* Single data point — show a centered dot + baseline */
  if (vals.length === 1) {
    const cx = width / 2;
    const cy = height / 2;
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke={color} strokeWidth="1" strokeOpacity="0.15" />
        <circle cx={cx} cy={cy} r="4" fill={color}>
          <animate attributeName="r" values="4;5.5;4" dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;0.6;1" dur="2s" repeatCount="indefinite" />
        </circle>
      </svg>
    );
  }

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const step = width / (vals.length - 1);
  const coords = vals.map((v, i) => ({
    x: i * step,
    y: height - ((v - min) / range) * (height - 6) - 3,
  }));
  const line = coords.map(c => `${c.x},${c.y}`).join(" ");
  const last = coords[coords.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      {filled && (
        <>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <polygon points={`0,${height} ${line} ${width},${height}`} fill={`url(#${gradId})`} />
        </>
      )}
      <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {filled && last && (
        <circle cx={last.x} cy={last.y} r="3" fill={color}>
          <animate attributeName="r" values="3;4.5;3" dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;0.6;1" dur="2s" repeatCount="indefinite" />
        </circle>
      )}
    </svg>
  );
}

export function YamlBlock(props: { filename?: string; children: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(props.children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const download = () => {
    const blob = new Blob([props.children], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = props.filename ?? "workflow.yml";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const actionBtn: Record<string, string> = {
    border: "none",
    background: "rgba(255,255,255,0.08)",
    color: "#8b949e",
    padding: "3px 10px",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.68rem",
    fontWeight: "600",
    fontFamily: T.font,
  };

  return (
    <div style={{ borderRadius: T.radius, overflow: "hidden", border: "1px solid #30363d" }}>
      {props.filename && (
        <div style={{
          background: "#1c2128",
          padding: "6px 16px",
          fontSize: "0.72rem",
          color: T.textSubtleOnDark,
          fontFamily: T.fontMono,
          borderBottom: "1px solid #30363d",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}>
          <span>{props.filename}</span>
          <span style={{ display: "flex", gap: "6px" }}>
            <button onClick={copy} style={actionBtn} title="Copy to clipboard">
              {copied ? "✓ Copied" : "📋 Copy"}
            </button>
            <button onClick={download} style={actionBtn} title="Download file">
              ⬇️ Download
            </button>
          </span>
        </div>
      )}
      <pre style={{ margin: 0, background: T.bgCode, color: T.textOnDark, padding: "16px", overflowX: "auto", fontSize: "0.75rem", lineHeight: 1.6, fontFamily: T.fontMono }}>
        {props.children}
      </pre>
    </div>
  );
}

/* ── Scroll animations ──────────────────────────────────── */

export function useInView(threshold = 0.2): { ref: preact.RefObject<HTMLDivElement>; visible: boolean } {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return { ref, visible };
}

export function FadeIn(props: { children: ComponentChildren; delay?: number; direction?: "up" | "left" | "scale" }) {
  const { ref, visible } = useInView(0.12);
  const d = props.delay ?? 0;
  const dir = props.direction ?? "up";
  const from: Record<string, string> = {
    up: "translateY(48px)",
    left: "translateX(48px)",
    scale: "scale(0.92)",
  };
  return (
    <div
      ref={ref}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "none" : from[dir],
        transition: `opacity 0.9s cubic-bezier(.16,1,.3,1) ${d}ms, transform 0.9s cubic-bezier(.16,1,.3,1) ${d}ms`,
      }}
    >
      {props.children}
    </div>
  );
}
