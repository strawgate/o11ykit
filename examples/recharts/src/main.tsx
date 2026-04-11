import {
  toRechartsHistogramModel,
  toRechartsLatestValuesModel,
  toRechartsTimeSeriesModel,
} from "@otlpkit/adapters/recharts";
import { buildHistogramFrame, buildLatestValuesFrame, buildTimeSeriesFrame } from "@otlpkit/views";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { sampleMetricsDocument } from "../../shared/sample.js";

const frame = buildTimeSeriesFrame(sampleMetricsDocument, {
  metricName: "logfwd.inflight_batches",
  intervalMs: 1000,
  splitBy: "output",
  title: "Inflight batches by output",
});
const latestValuesFrame = buildLatestValuesFrame(sampleMetricsDocument, {
  metricName: "logfwd.inflight_batches",
  splitBy: "output",
  title: "Latest inflight batches by output",
});
const histogramFrame = buildHistogramFrame(sampleMetricsDocument, {
  metricName: "logfwd.output.duration",
  title: "Output duration histogram",
  binCount: 6,
});
const timeSeriesModel = toRechartsTimeSeriesModel(frame);
const latestValuesModel = toRechartsLatestValuesModel(latestValuesFrame);
const histogramModel = toRechartsHistogramModel(histogramFrame);

function App(): JSX.Element {
  return (
    <div style={{ display: "grid", gap: 24, width: 960 }}>
      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12, marginTop: 0 }}>Time Series</h2>
        <div style={{ height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={timeSeriesModel.data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={timeSeriesModel.xAxisKey} type="number" />
              <YAxis unit={timeSeriesModel.unit ?? ""} />
              <Tooltip />
              <Legend />
              {timeSeriesModel.series.map((series) => (
                <Line
                  key={series.dataKey}
                  dataKey={series.dataKey}
                  name={series.name}
                  dot={false}
                  strokeWidth={2}
                  type="linear"
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12, marginTop: 0 }}>Latest Values</h2>
        <div style={{ height: 320 }}>
          <ResponsiveContainer>
            <BarChart data={latestValuesModel.data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={latestValuesModel.categoryKey} />
              <YAxis unit={latestValuesModel.unit ?? ""} />
              <Tooltip />
              <Legend />
              <Bar
                dataKey={latestValuesModel.valueKey}
                fill="#4c8bf5"
                name={latestValuesFrame.title}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12, marginTop: 0 }}>Histogram</h2>
        <div style={{ height: 320 }}>
          <ResponsiveContainer>
            <BarChart data={histogramModel.data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={histogramModel.categoryKey} />
              <YAxis unit={histogramModel.unit ?? ""} />
              <Tooltip />
              <Legend />
              <Bar dataKey={histogramModel.valueKey} fill="#0f9d58" name={histogramFrame.title} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}

const rootElement = document.querySelector<HTMLDivElement>("#root");

if (!rootElement) {
  throw new Error("Expected #root container to exist.");
}

createRoot(rootElement).render(<App />);
