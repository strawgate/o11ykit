/**
 * Ingest loader — sends identical OTLP payloads to all three TSDBs.
 *
 * Uses protobuf encoding for all targets:
 * - VictoriaMetrics requires protobuf (rejects JSON for OTLP)
 * - Prometheus and Mimir accept both, but protobuf is more efficient
 */

import type { BenchConfig, TsdbTarget } from "./config.js";
import type { OtlpExportRequest } from "./generator.js";
import { encodeProtobuf } from "./proto-encode.js";

export interface IngestResult {
  target: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  errors: string[];
  durationMs: number;
}

/**
 * Send all generated OTLP requests to a single TSDB target.
 * Uses protobuf encoding (required by VictoriaMetrics, optimal for all).
 */
async function ingestToTarget(
  target: TsdbTarget,
  requests: OtlpExportRequest[],
): Promise<IngestResult> {
  const start = performance.now();
  let successCount = 0;
  let errorCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < requests.length; i++) {
    const body = encodeProtobuf(requests[i]);
    const headers: Record<string, string> = {
      "Content-Type": "application/x-protobuf",
      ...target.otlpHeaders,
    };

    try {
      const resp = await fetch(target.otlpUrl, {
        method: "POST",
        headers,
        body: body as unknown as BodyInit,
      });

      if (resp.ok) {
        successCount++;
      } else {
        const text = await resp.text();
        const msg = `[${target.name}] req ${i}: ${resp.status} ${text.slice(0, 200)}`;
        errors.push(msg);
        errorCount++;
      }
    } catch (err) {
      const msg = `[${target.name}] req ${i}: ${(err as Error).message}`;
      errors.push(msg);
      errorCount++;
    }

    if ((i + 1) % 10 === 0 || i === requests.length - 1) {
      process.stdout.write(
        `\r  ${target.name}: ${i + 1}/${requests.length} requests sent`
      );
    }
  }
  process.stdout.write("\n");

  return {
    target: target.name,
    totalRequests: requests.length,
    successCount,
    errorCount,
    errors: errors.slice(0, 10),
    durationMs: performance.now() - start,
  };
}

/**
 * Ingest to all targets sequentially. We do sequential (not parallel) so
 * we don't conflate TSDB ingestion performance with network contention.
 */
export async function ingestToAll(
  targets: TsdbTarget[],
  requests: OtlpExportRequest[],
  _config: BenchConfig,
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];

  for (const target of targets) {
    console.log(`\nIngesting to ${target.name} (${target.otlpUrl})...`);
    const result = await ingestToTarget(target, requests);
    results.push(result);
    console.log(
      `  ✓ ${result.successCount}/${result.totalRequests} succeeded in ${(result.durationMs / 1000).toFixed(1)}s`
    );
    if (result.errors.length > 0) {
      console.log(`  ⚠ Errors:`);
      for (const e of result.errors) {
        console.log(`    ${e}`);
      }
    }
  }

  return results;
}

/**
 * Wait for data to be queryable in all targets.
 */
export async function waitForData(
  targets: TsdbTarget[],
  timeoutMs = 30_000,
): Promise<void> {
  console.log("\nWaiting for data to be queryable...");

  const deadline = Date.now() + timeoutMs;
  for (const target of targets) {
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const url = `${target.queryUrl}?query=count(bench_cpu_usage_percent)`;
        const headers: Record<string, string> = { ...target.otlpHeaders };
        const resp = await fetch(url, { headers });
        if (resp.ok) {
          const data = (await resp.json()) as {
            data?: { result?: { value?: [number, string] }[] };
          };
          const result = data?.data?.result;
          if (result && result.length > 0 && Number(result[0]?.value?.[1]) > 0) {
            console.log(`  ✓ ${target.name}: data is queryable`);
            ready = true;
            break;
          }
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready) {
      console.log(`  ⚠ ${target.name}: timed out waiting for data`);
    }
  }
}
