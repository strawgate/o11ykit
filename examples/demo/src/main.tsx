import {
  toRechartsHistogramData,
  toRechartsLatestValuesData,
  toRechartsTimeSeriesData,
} from "@otlpkit/adapters/recharts";
import { toUPlotTimeSeriesArgs } from "@otlpkit/adapters/uplot";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import uPlot, { type AlignedData, type Options, type Series } from "uplot";
import "uplot/dist/uPlot.min.css";

import { queryMetric } from "./demo-store.js";
import "./styles.css";

// Query the RowGroupStore via ScanEngine for each metric
const inflightResult = queryMetric("checkout.inflight_requests");
const retryResult = queryMetric("checkout.retry_rate");
const errorResult = queryMetric("checkout.error_rate");
const durationResult = queryMetric("checkout.request.duration_ms");
const cpuResult = queryMetric("collector.cpu_percent");

const adapterOpts = { timestampUnit: "nanoseconds" as const };

const inflightModel = toRechartsTimeSeriesData(inflightResult, adapterOpts);
const retryModel = toRechartsTimeSeriesData(retryResult, adapterOpts);
const errorModel = toRechartsLatestValuesData(errorResult, adapterOpts);
const durationModel = toRechartsHistogramData(durationResult, { ...adapterOpts, bucketCount: 7 });
const collectorPulseModel = toUPlotTimeSeriesArgs(cpuResult, adapterOpts);

const routeKeys = inflightModel.series.map((series) => series.dataKey);
const peakInflight = inflightModel.data.reduce((peak, row) => {
  const total = routeKeys.reduce((sum, key) => {
    const value = row[key];
    return sum + (typeof value === "number" ? value : 0);
  }, 0);
  return Math.max(peak, total);
}, 0);
const highestErrorRoute = errorModel.data.reduce<(typeof errorModel.data)[number] | null>(
  (worst, row) => {
    const currentVal = typeof row.value === "number" ? row.value : 0;
    const worstVal = worst ? (typeof worst.value === "number" ? worst.value : 0) : 0;
    return !worst || currentVal > worstVal ? row : worst;
  },
  null
);
const retryValues = retryModel.data.flatMap((row) =>
  retryModel.series.map((s) => {
    const v = row[s.dataKey];
    return typeof v === "number" ? v : 0;
  })
);
const averageRetryRate =
  retryValues.length > 0 ? retryValues.reduce((s, v) => s + v, 0) / retryValues.length : 0;
const modalLatencyBin = durationModel.data.reduce<(typeof durationModel.data)[number] | null>(
  (mostFrequent, bin) => {
    const currentCount = typeof bin.count === "number" ? bin.count : 0;
    const bestCount = mostFrequent
      ? typeof mostFrequent.count === "number"
        ? mostFrequent.count
        : 0
      : 0;
    return !mostFrequent || currentCount > bestCount ? bin : mostFrequent;
  },
  null
);
const healthScore = Math.max(
  0,
  Math.round(
    100 -
      peakInflight * 0.23 -
      (typeof highestErrorRoute?.value === "number" ? highestErrorRoute.value : 0) * 8 -
      averageRetryRate * 14
  )
);

function UPlotPulseCard({ model }: { readonly model: typeof collectorPulseModel }): JSX.Element {
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = chartRef.current;
    if (!element) {
      return;
    }

    let plot: uPlot | null = null;
    const render = () => {
      const width = Math.max(320, Math.floor(element.clientWidth));
      if (plot) {
        plot.destroy();
      }
      const alignedData = model.data.map((column) => [...column]) as AlignedData;
      const options: Options = {
        width,
        height: 220,
        title: model.options.title,
        scales: {
          x: {
            time: model.options.scales.x.time,
          },
          y: {
            auto: model.options.scales.y.auto,
          },
        },
        axes: model.options.axes.map((axis) => ({ ...axis })),
        series: model.options.series.map(toUPlotSeries),
      };
      plot = new uPlot(options, alignedData, element);
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(element);

    return () => {
      observer.disconnect();
      if (plot) {
        plot.destroy();
      }
    };
  }, [model]);

  return (
    <div className="pulse-card" data-testid="collector-pulse">
      <div className="pulse-label">Live infra pulse</div>
      <div className="pulse-chart" ref={chartRef} />
    </div>
  );
}

function toUPlotSeries(series: (typeof collectorPulseModel.options.series)[number]): Series {
  return {
    label: series.label,
    ...(series.points ? { points: { ...series.points } } : {}),
  };
}

function MeasuredChart({
  testId,
  children,
}: {
  readonly testId: string;
  readonly children: (size: { readonly width: number; readonly height: number }) => JSX.Element;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const measure = () => {
      setSize({
        width: Math.floor(element.clientWidth),
        height: Math.floor(element.clientHeight),
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div className="chart-shell" data-testid={testId} ref={containerRef}>
      {size.width > 0 && size.height > 0 ? children(size) : null}
    </div>
  );
}

function StoryStat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <article className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </article>
  );
}

function App(): JSX.Element {
  return (
    <main className="story-shell">
      <section className="hero">
        <div className="hero-top">
          <img
            alt="OpenTelemetry logo"
            src="https://opentelemetry.io/img/logos/opentelemetry-horizontal-color.svg"
          />
          <span className="chip">OpenTelemetry + OtlpKit demo</span>
        </div>
        <h1 data-testid="hero-title">Checkout Incident Timeline (10s)</h1>
        <p>
          This synthetic incident follows one bursty launch window. Emit OTLP from your app, expose
          OTLP JSON to the client, and project it into chart-ready views. A more advanced pattern
          uses a processor pipeline that keeps traces, metrics, and logs in a ring buffer behind a
          diagnostics API.
        </p>
      </section>

      <section className="kpi-grid" data-testid="story-kpis">
        <StoryStat label="Peak inflight load" value={`${peakInflight} requests`} />
        <StoryStat
          label="Highest error route"
          value={`${highestErrorRoute?.label ?? "unknown"} (${(typeof highestErrorRoute?.value === "number" ? highestErrorRoute.value : 0).toFixed(1)}%)`}
        />
        <StoryStat label="Mean retry rate" value={`${averageRetryRate.toFixed(2)}%`} />
        <StoryStat label="Incident health score" value={`${healthScore}/100`} />
      </section>

      <section className="story-grid">
        <article className="act-card">
          <h2 className="act-title">1. Request Volume</h2>
          <p className="act-copy">
            Traffic rises across checkout, inventory, and payment at once. Summed concurrency gives
            a fast first signal of whether pressure is demand-driven or system-driven.
          </p>
          <MeasuredChart testId="act-demand-wave">
            {({ width, height }) => (
              <LineChart data={inflightModel.data} height={height} width={width}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey={inflightModel.xAxisKey}
                  tickFormatter={(value) => `${value / 1000}s`}
                  type="number"
                />
                <YAxis unit={inflightModel.unit ?? ""} />
                <Tooltip />
                <Legend />
                {inflightModel.series.map((series, index) => (
                  <Line
                    dataKey={series.dataKey}
                    dot={false}
                    key={series.dataKey}
                    name={series.name}
                    stroke={["#ff5f33", "#1aa3a3", "#ef8f00"][index % 3] ?? "#ff5f33"}
                    strokeWidth={2.5}
                    type="monotone"
                  />
                ))}
              </LineChart>
            )}
          </MeasuredChart>
        </article>

        <article className="act-card">
          <h2 className="act-title">2. Retry Rate</h2>
          <p className="act-copy">
            Retries spike before errors settle, especially on payment. This helps separate
            short-lived retry storms from harder failures.
          </p>
          <MeasuredChart testId="act-retry-turbulence">
            {({ width, height }) => (
              <LineChart data={retryModel.data} height={height} width={width}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey={retryModel.xAxisKey}
                  tickFormatter={(value) => `${value / 1000}s`}
                  type="number"
                />
                <YAxis unit={retryModel.unit ?? ""} />
                <Tooltip />
                <Legend />
                {retryModel.series.map((series, index) => (
                  <Line
                    dataKey={series.dataKey}
                    dot={false}
                    key={series.dataKey}
                    name={series.name}
                    stroke={["#f04e98", "#6f5ef7", "#ff8a4f"][index % 3] ?? "#f04e98"}
                    strokeWidth={2.5}
                    type="monotone"
                  />
                ))}
              </LineChart>
            )}
          </MeasuredChart>
        </article>

        <article className="act-card">
          <h2 className="act-title">3. Error Snapshot</h2>
          <p className="act-copy">
            Latest-value error rates provide a route-by-route snapshot at incident end. Payment is
            still highest, but no route is in runaway mode.
          </p>
          <MeasuredChart testId="act-error-rates">
            {({ width, height }) => (
              <BarChart data={errorModel.data} height={height} width={width}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey={errorModel.categoryKey} />
                <YAxis unit={errorModel.unit ?? ""} />
                <Tooltip />
                <Bar
                  dataKey={errorModel.valueKey}
                  fill="#ff8a4f"
                  name="Error rate"
                  radius={[8, 8, 0, 0]}
                />
              </BarChart>
            )}
          </MeasuredChart>
        </article>

        <article className="act-card">
          <h2 className="act-title">4. Latency Distribution</h2>
          <p className="act-copy">
            The most populated latency band is <strong>{modalLatencyBin?.label ?? "n/a"}</strong>.
            The long tail is still present, but most requests have shifted back toward safer
            response times.
          </p>
          <MeasuredChart testId="act-latency-shape">
            {({ width, height }) => (
              <BarChart data={durationModel.data} height={height} width={width}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey={durationModel.categoryKey} />
                <YAxis unit="count" />
                <Tooltip />
                <Bar
                  dataKey={durationModel.valueKey}
                  fill="#1aa3a3"
                  name="Samples"
                  radius={[8, 8, 0, 0]}
                />
              </BarChart>
            )}
          </MeasuredChart>
        </article>

        <article className="act-card">
          <h2 className="act-title">5. Collector CPU</h2>
          <p className="act-copy">
            uPlot tracks collector CPU in parallel so platform load stays visible while app-facing
            charts show request behavior.
          </p>
          <UPlotPulseCard model={collectorPulseModel} />
        </article>
      </section>

      <footer className="footer-note">
        Data source: deterministic metrics in <code>examples/demo/src/demo-store.ts</code>, stored
        in a RowGroupStore and queried via ScanEngine.
      </footer>
    </main>
  );
}

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("Expected #root to exist.");
}

createRoot(root).render(<App />);
