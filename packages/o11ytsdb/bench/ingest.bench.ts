import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BenchReport, printReport, Suite } from "./harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

type OtlpMetric = import("@otlpkit/otlpjson").OtlpMetric;
type OtlpMetricsDocument = import("@otlpkit/otlpjson").OtlpMetricsDocument;

const METRIC_BATCHES = [100, 1_000, 10_000];

function buildSyntheticPayload(metricCount: number): OtlpMetricsDocument {
  const metrics: OtlpMetric[] = [];
  const baseTs = 1_710_000_000_000_000_000n;

  for (let i = 0; i < metricCount; i++) {
    metrics.push({
      name: `bench.cpu.utilization.${i % 32}`,
      gauge: {
        dataPoints: [
          {
            timeUnixNano: (baseTs + BigInt(i) * 1_000_000_000n).toString(),
            attributes: [
              { key: "host.name", value: { stringValue: `node-${i % 256}` } },
              { key: "cpu", value: { stringValue: String(i % 8) } },
            ],
            asDouble: 0.25 + (i % 100) / 100,
          },
        ],
      },
    });
  }

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "o11ytsdb-ingest-bench" } },
            { key: "service.instance.id", value: { stringValue: "bench-1" } },
          ],
        },
        scopeMetrics: [
          {
            scope: {
              name: "bench.ingest",
              version: "0.0.1",
            },
            metrics,
          },
        ],
      },
    ],
  };
}

export default async function (): Promise<BenchReport> {
  const suite = new Suite("ingest");
  const { FlatStore } = await import(pkgPath("dist/flat-store.js"));
  const { ingestOtlpJson } = await import(pkgPath("dist/ingest.js"));

  for (const metricCount of METRIC_BATCHES) {
    const payload = buildSyntheticPayload(metricCount);

    suite.add(
      `ingest_${metricCount}_metrics`,
      "ts",
      () => {
        const storage = new FlatStore();
        ingestOtlpJson(payload, storage);
      },
      {
        warmup: 10,
        iterations: 30,
        itemsPerCall: metricCount,
        unit: "samples/sec",
      }
    );
  }

  const report = suite.run();
  printReport(report);
  return report;
}
