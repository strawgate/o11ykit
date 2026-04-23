import { describe, expect, it } from "vitest";
import {
  buildMetricDimensionViews,
  buildMetricOverviewConfig,
  collectMetricMeta,
  formatMetricName,
  recommendedGroupByForMetric,
} from "../js/metrics-model.js";
import { FlatStore } from "../js/stores.js";

const SEC = 1_000_000_000n;

function buildStore(seriesData) {
  const store = new FlatStore();
  for (const { labels, timestamps, values } of seriesData) {
    const id = store.getOrCreateSeries(new Map(labels));
    store.appendBatch(id, new BigInt64Array(timestamps), new Float64Array(values));
  }
  return store;
}

describe("metrics-model", () => {
  it("formats dotted and underscored metric names for display", () => {
    expect(formatMetricName("k8s.pod.cpu_usage")).toBe("k8s pod cpu usage");
  });

  it("prefers low-cardinality shared labels over very high-cardinality labels", () => {
    const seriesData = [];
    const namespaces = ["checkout", "payments"];
    const nodes = ["node-a", "node-b"];
    let podIndex = 0;
    for (const namespace of namespaces) {
      for (const node of nodes) {
        for (let replica = 0; replica < 3; replica++) {
          seriesData.push({
            labels: [
              ["__name__", "k8s.pod.cpu.usage"],
              ["k8s.namespace.name", namespace],
              ["k8s.node.name", node],
              ["k8s.pod.name", `pod-${podIndex++}`],
            ],
            timestamps: [0n, 15n * SEC],
            values: [0.2 + replica, 0.4 + replica],
          });
        }
      }
    }

    const store = buildStore(seriesData);
    const meta = collectMetricMeta(store, "k8s.pod.cpu.usage");

    expect(meta.seriesCount).toBe(12);
    expect(meta.rankedLabels[0].label).toBe("k8s.namespace.name");
    expect(meta.rankedLabels[1].label).toBe("k8s.node.name");
    expect(meta.rankedLabels.at(-1)?.label).toBe("k8s.pod.name");
  });

  it("recommends group-by labels from the ranked metadata", () => {
    const store = buildStore([
      {
        labels: [
          ["__name__", "http_requests_total"],
          ["service", "frontend"],
          ["region", "us-east"],
          ["instance", "web-01"],
        ],
        timestamps: [0n, 10n * SEC],
        values: [0, 10],
      },
      {
        labels: [
          ["__name__", "http_requests_total"],
          ["service", "frontend"],
          ["region", "us-west"],
          ["instance", "web-02"],
        ],
        timestamps: [0n, 10n * SEC],
        values: [0, 12],
      },
      {
        labels: [
          ["__name__", "http_requests_total"],
          ["service", "api"],
          ["region", "us-east"],
          ["instance", "api-01"],
        ],
        timestamps: [0n, 10n * SEC],
        values: [0, 20],
      },
    ]);

    expect(recommendedGroupByForMetric(store, "http_requests_total", 2)).toEqual([
      "region",
      "service",
    ]);
  });

  it("builds overview and dimension configs from collected metadata", () => {
    const store = buildStore([
      {
        labels: [
          ["__name__", "http_requests_total"],
          ["service", "frontend"],
          ["region", "us-east"],
        ],
        timestamps: [0n, 10n * SEC],
        values: [0, 10],
      },
      {
        labels: [
          ["__name__", "http_requests_total"],
          ["service", "api"],
          ["region", "us-east"],
        ],
        timestamps: [0n, 10n * SEC],
        values: [0, 15],
      },
    ]);

    const meta = collectMetricMeta(store, "http_requests_total");
    const overview = buildMetricOverviewConfig(meta);
    const views = buildMetricDimensionViews(meta);

    expect(overview.transform).toBe("rate");
    expect(overview.agg).toBe("sum");
    expect(views[0].title).toBe("all series");
    expect(views.some((view) => view.title === "service")).toBe(true);
  });
});
