import {
  toRechartsHistogramModel,
  toRechartsLatestValuesModel,
  toRechartsTimeSeriesModel,
} from "@otlpkit/adapters/recharts";
import { toUPlotTimeSeriesModel } from "@otlpkit/adapters/uplot";
import { buildHistogramFrame, buildLatestValuesFrame, buildTimeSeriesFrame } from "@otlpkit/views";
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
import uPlot, { type AlignedData, type Options } from "uplot";
import "uplot/dist/uPlot.min.css";

import { demoMetricsDocument } from "./demo-data.js";
import "./styles.css";

const inflightFrame = buildTimeSeriesFrame(demoMetricsDocument, {
  metricName: "checkout.inflight_requests",
  intervalMs: 1000,
  splitBy: "route",
  title: "Checkout inflight requests",
});
const retryFrame = buildTimeSeriesFrame(demoMetricsDocument, {
  metricName: "checkout.retry_rate",
  intervalMs: 1000,
  splitBy: "route",
  title: "Retry-rate turbulence",
});
const errorFrame = buildLatestValuesFrame(demoMetricsDocument, {
  metricName: "checkout.error_rate",
  splitBy: "route",
  title: "Final route error rates",
});
const durationFrame = buildHistogramFrame(demoMetricsDocument, {
  metricName: "checkout.request.duration_ms",
  title: "Request latency shape",
  binCount: 7,
});
const collectorPulseFrame = buildTimeSeriesFrame(demoMetricsDocument, {
  metricName: "collector.cpu_percent",
  intervalMs: 1000,
  splitBy: "pod",
  title: "Collector heartbeat",
});

const inflightModel = toRechartsTimeSeriesModel(inflightFrame);
const retryModel = toRechartsTimeSeriesModel(retryFrame);
const errorModel = toRechartsLatestValuesModel(errorFrame);
const durationModel = toRechartsHistogramModel(durationFrame);
const collectorPulseModel = toUPlotTimeSeriesModel(collectorPulseFrame);

const routeKeys = inflightModel.series.map((series) => series.dataKey);
const peakInflight = inflightModel.data.reduce((peak, row) => {
  const total = routeKeys.reduce((sum, key) => {
    const value = row[key];
    return sum + (typeof value === "number" ? value : 0);
  }, 0);
  return Math.max(peak, total);
}, 0);
const highestErrorRoute = errorFrame.rows.reduce<(typeof errorFrame.rows)[number] | null>(
  (worst, row) => (!worst || row.value > worst.value ? row : worst),
  null
);
const retrySamples = retryFrame.series.flatMap((series) => series.points);
const averageRetryRate =
  retrySamples.length > 0
    ? retrySamples.reduce((sum, point) => sum + point.value, 0) / retrySamples.length
    : 0;
const modalLatencyBin = durationFrame.bins.reduce<(typeof durationFrame.bins)[number] | null>(
  (mostFrequent, bin) => (!mostFrequent || bin.count > mostFrequent.count ? bin : mostFrequent),
  null
);
const healthScore = Math.max(
  0,
  Math.round(
    100 - peakInflight * 0.23 - (highestErrorRoute?.value ?? 0) * 8 - averageRetryRate * 14
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
        series: model.options.series.map((series) => ({ ...series })),
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
          <span className="chip">OTel x OtlpKit Incident Theater</span>
        </div>
        <h1 data-testid="hero-title">Ten Seconds In The Life Of A Spiky Checkout</h1>
        <p>
          This synthetic incident follows one bursty launch window. OtlpKit consumes OTLP JSON and
          projects it into chart-ready views, so each scene maps directly to a real telemetry
          question an on-call engineer would ask.
        </p>
      </section>

      <section className="kpi-grid" data-testid="story-kpis">
        <StoryStat label="Peak inflight load" value={`${peakInflight} requests`} />
        <StoryStat
          label="Noisiest route"
          value={`${highestErrorRoute?.label ?? "unknown"} (${(highestErrorRoute?.value ?? 0).toFixed(1)}%)`}
        />
        <StoryStat label="Mean retry rate" value={`${averageRetryRate.toFixed(2)}%`} />
        <StoryStat label="Narrative health score" value={`${healthScore}/100`} />
      </section>

      <section className="story-grid">
        <article className="act-card">
          <h2 className="act-title">Act I: Demand Wave</h2>
          <p className="act-copy">
            Traffic ramps across checkout, inventory, and payment at once. Summed concurrency gives
            a quick first clue about whether the incident is demand-driven or system-driven.
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
          <h2 className="act-title">Act II: Retry Turbulence</h2>
          <p className="act-copy">
            Retries spike before errors settle, especially on payment. This helps separate transient
            retry storms from hard failures.
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
          <h2 className="act-title">Act III: Where Errors Landed</h2>
          <p className="act-copy">
            Latest-value error rates give a clean route-by-route snapshot at incident end. Payment
            is still hottest, but no route is in runaway mode.
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
          <h2 className="act-title">Act IV: Latency Shape</h2>
          <p className="act-copy">
            The most populated latency band is <strong>{modalLatencyBin?.label ?? "n/a"}</strong>.
            The long tail exists, but the center of mass moved back toward safer response times.
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
          <h2 className="act-title">Act V: Backstage Pulse</h2>
          <p className="act-copy">
            uPlot tracks collector CPU in parallel so platform load stays visible while app-facing
            charts tell the request story.
          </p>
          <UPlotPulseCard model={collectorPulseModel} />
        </article>
      </section>

      <footer className="footer-note">
        data source: synthetic OTLP metrics document in <code>examples/demo/src/demo-data.ts</code>
      </footer>
    </main>
  );
}

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("Expected #root to exist.");
}

createRoot(root).render(<App />);
