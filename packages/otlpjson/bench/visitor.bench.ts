import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BenchReport, printReport, Suite } from "./harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function pkgPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

type OtlpTracesDocument = import("@otlpkit/otlpjson").OtlpTracesDocument;
type OtlpLogsDocument = import("@otlpkit/otlpjson").OtlpLogsDocument;

const SPAN_BATCHES = [100, 1_000, 10_000];
const LOG_BATCHES = [100, 1_000, 10_000];

function buildSyntheticTracesPayload(spanCount: number): OtlpTracesDocument {
  const spans: Array<{
    traceId: string;
    spanId: string;
    parentSpanId: string;
    name: string;
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: Array<{ key: string; value: { stringValue: string } }>;
    status: { code: number };
    events: Array<{
      timeUnixNano: string;
      name: string;
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    }>;
    links: Array<{
      traceId: string;
      spanId: string;
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    }>;
  }> = [];

  for (let i = 0; i < spanCount; i++) {
    spans.push({
      traceId: `trace-${i % 256}`,
      spanId: `span-${i}`,
      parentSpanId: i % 10 === 0 ? "" : `span-${i - 1}`,
      name: `operation.${i % 32}`,
      kind: i % 3 === 0 ? 1 : 3,
      startTimeUnixNano: `${1_710_000_000_000_000_000n + BigInt(i) * 1_000_000n}`,
      endTimeUnixNano: `${1_710_000_000_000_000_000n + BigInt(i) * 1_000_000n + 1_000_000n}`,
      attributes: [
        { key: "host.name", value: { stringValue: `node-${i % 256}` } },
        { key: "region", value: { stringValue: `region-${i % 8}` } },
      ],
      status: { code: 1 },
      events:
        i % 5 === 0
          ? [
              {
                timeUnixNano: `${1_710_000_000_000_000_000n + BigInt(i) * 1_000_000n + 500_000n}`,
                name: "event.checkpoint",
                attributes: [{ key: "result", value: { stringValue: "ok" } }],
              },
            ]
          : [],
      links: i % 10 === 0 ? [] : [],
    });
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "traces-bench" } },
            { key: "service.instance.id", value: { stringValue: "bench-1" } },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: "bench.traces",
              version: "0.0.1",
            },
            spans,
          },
        ],
      },
    ],
  };
}

function buildSyntheticLogsPayload(logCount: number): OtlpLogsDocument {
  const logRecords: Array<{
    timeUnixNano: string;
    observedTimeUnixNano: string;
    severityNumber: number;
    severityText: string;
    body: { stringValue: string };
    attributes: Array<{ key: string; value: { stringValue: string } }>;
    traceId: string;
    spanId: string;
    flags: number;
  }> = [];

  for (let i = 0; i < logCount; i++) {
    logRecords.push({
      timeUnixNano: `${1_710_000_000_000_000_000n + BigInt(i) * 1_000_000n}`,
      observedTimeUnixNano: `${1_710_000_000_000_000_000n + BigInt(i) * 1_000_000n + 100_000n}`,
      severityNumber: i % 5 === 0 ? 13 : 9,
      severityText: i % 5 === 0 ? "WARN" : "INFO",
      body: { stringValue: `Log message ${i % 100}` },
      attributes: [
        { key: "host.name", value: { stringValue: `node-${i % 256}` } },
        { key: "level", value: { stringValue: i % 5 === 0 ? "warn" : "info" } },
      ],
      traceId: `trace-${i % 256}`,
      spanId: `span-${i % 1000}`,
      flags: 1,
    });
  }

  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "logs-bench" } },
            { key: "service.instance.id", value: { stringValue: "bench-1" } },
          ],
        },
        scopeLogs: [
          {
            scope: {
              name: "bench.logs",
              version: "0.0.1",
            },
            logRecords,
          },
        ],
      },
    ],
  };
}

export default async function (): Promise<BenchReport> {
  const suite = new Suite("otlpjson-visitors");
  const {
    collectSpans,
    collectLogRecords,
    visitLogRecords,
    SpanConverter,
    LogConverter,
    projectSpans,
    projectLogs,
  } = await import(pkgPath("@otlpkit/otlpjson"));

  const spanConverter = new SpanConverter();
  const logConverter = new LogConverter();

  const spanFields = ["traceId", "spanId", "name"] as const;

  for (const spanCount of SPAN_BATCHES) {
    const payload = buildSyntheticTracesPayload(spanCount);

    suite.add(
      `spans_iterate_${spanCount}`,
      "ts",
      () => {
        const result = collectSpans(payload);
        if (result.length === 0) throw new Error("no spans");
      },
      { warmup: 10, iterations: 30, itemsPerCall: spanCount, unit: "spans/sec" }
    );

    suite.add(
      `spans_converter_${spanCount}`,
      "ts",
      () => {
        let count = 0;
        spanConverter.run(payload, {
          onSpan() {
            count++;
          },
        });
        if (count === 0) throw new Error("no spans");
      },
      { warmup: 10, iterations: 30, itemsPerCall: spanCount, unit: "spans/sec" }
    );

    suite.add(
      `spans_project_${spanCount}`,
      "ts",
      () => {
        const result = projectSpans(payload, spanFields);
        if (result.length === 0) throw new Error("no spans");
      },
      { warmup: 10, iterations: 30, itemsPerCall: spanCount, unit: "spans/sec" }
    );
  }

  const logFields = ["severityText", "body"] as const;

  for (const logCount of LOG_BATCHES) {
    const payload = buildSyntheticLogsPayload(logCount);

    suite.add(
      `logs_iterate_${logCount}`,
      "ts",
      () => {
        const result = collectLogRecords(payload);
        if (result.length === 0) throw new Error("no logs");
      },
      { warmup: 10, iterations: 30, itemsPerCall: logCount, unit: "logs/sec" }
    );

    suite.add(
      `logs_visit_${logCount}`,
      "ts",
      () => {
        let count = 0;
        visitLogRecords(payload, {
          onLogRecord() {
            count++;
          },
        });
        if (count === 0) throw new Error("no logs");
      },
      { warmup: 10, iterations: 30, itemsPerCall: logCount, unit: "logs/sec" }
    );

    suite.add(
      `logs_converter_${logCount}`,
      "ts",
      () => {
        let count = 0;
        logConverter.run(payload, {
          onLogRecord() {
            count++;
          },
        });
        if (count === 0) throw new Error("no logs");
      },
      { warmup: 10, iterations: 30, itemsPerCall: logCount, unit: "logs/sec" }
    );

    suite.add(
      `logs_project_${logCount}`,
      "ts",
      () => {
        const result = projectLogs(payload, logFields);
        if (result.length === 0) throw new Error("no logs");
      },
      { warmup: 10, iterations: 30, itemsPerCall: logCount, unit: "logs/sec" }
    );
  }

  const report = suite.run();
  printReport(report);
  return report;
}
