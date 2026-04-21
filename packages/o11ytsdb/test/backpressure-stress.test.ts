/**
 * Stress test: demonstrates unbounded ingest without backpressure vs bounded.
 *
 * Run with: npx vitest run test/backpressure-stress.test.ts
 *
 * This test uses a mock worker with artificial latency to simulate a slow
 * consumer. It fires a burst of ingest calls and measures:
 *   - Peak pending map size (proxy for memory pressure)
 *   - Whether all promises resolve
 *   - Throughput gating behavior
 */
import { describe, expect, it } from "vitest";

import { WorkerClient } from "../src/worker-client.js";
import type { RequestEnvelope, ResponseEnvelope } from "../src/worker-protocol.js";

type MessageListener = (event: { data: unknown }) => void;

/**
 * Mock worker that processes ingest requests with configurable latency.
 * Simulates a worker that takes `latencyMs` per ingest to stress the queue.
 */
function createSlowWorker(latencyMs: number) {
  const listeners: MessageListener[] = [];
  let peakPending = 0;
  let currentPending = 0;
  let totalProcessed = 0;

  const worker = {
    postMessage(message: unknown, _transfer?: ArrayBufferLike[]): void {
      const envelope = message as RequestEnvelope;
      if (envelope.kind !== "request") return;

      currentPending++;
      if (currentPending > peakPending) peakPending = currentPending;

      // Simulate processing delay.
      setTimeout(() => {
        currentPending--;
        totalProcessed++;

        let payload: ResponseEnvelope["payload"];
        if (envelope.payload.type === "ingest") {
          payload = {
            ok: true as const,
            type: "ingest" as const,
            seriesId: 0,
            ingestedSamples: (envelope.payload as { values: Float64Array }).values.length,
          };
        } else if (envelope.payload.type === "init") {
          payload = { ok: true as const, type: "init" as const, backend: "mock" };
        } else {
          payload = { ok: true as const, type: "close" as const };
        }

        const response: ResponseEnvelope = {
          id: envelope.id,
          kind: "response",
          payload,
        };

        for (const listener of listeners) listener({ data: response });
      }, latencyMs);
    },
    addEventListener(_type: string, listener: MessageListener): void {
      listeners.push(listener);
    },
    terminate(): void {},
  };

  return {
    worker,
    get peakPending() {
      return peakPending;
    },
    get totalProcessed() {
      return totalProcessed;
    },
  };
}

const BURST_SIZE = 200;
const SAMPLES_PER_BATCH = 1000;
const WORKER_LATENCY_MS = 5;

function makeBatch() {
  const timestamps = new BigInt64Array(SAMPLES_PER_BATCH);
  const values = new Float64Array(SAMPLES_PER_BATCH);
  for (let i = 0; i < SAMPLES_PER_BATCH; i++) {
    timestamps[i] = BigInt(Date.now() * 1_000_000 + i);
    values[i] = Math.random() * 100;
  }
  return { timestamps, values };
}

describe("Backpressure stress test", () => {
  it("without backpressure: all 200 requests go in-flight at once", async () => {
    const slow = createSlowWorker(WORKER_LATENCY_MS);
    const client = new WorkerClient({
      worker: slow.worker,
      transferStrategy: "structured-clone", // don't neuter buffers
      maxInflightIngest: Infinity, // DISABLE backpressure
    });

    const labels = new Map([["__name__", "stress"]]);
    const promises: Promise<unknown>[] = [];

    // Fire all at once — no backpressure.
    for (let i = 0; i < BURST_SIZE; i++) {
      const { timestamps, values } = makeBatch();
      promises.push(client.ingest(labels, timestamps, values));
    }

    await Promise.all(promises);

    // Without backpressure, peak pending should equal the full burst.
    expect(slow.peakPending).toBe(BURST_SIZE);
    expect(slow.totalProcessed).toBe(BURST_SIZE);
  }, 30_000);

  it("with backpressure (max=16): peak in-flight capped at 16", async () => {
    const slow = createSlowWorker(WORKER_LATENCY_MS);
    const client = new WorkerClient({
      worker: slow.worker,
      transferStrategy: "structured-clone",
      maxInflightIngest: 16,
    });

    const labels = new Map([["__name__", "stress"]]);
    const promises: Promise<unknown>[] = [];

    for (let i = 0; i < BURST_SIZE; i++) {
      const { timestamps, values } = makeBatch();
      promises.push(client.ingest(labels, timestamps, values));
    }

    await Promise.all(promises);

    // Peak in-flight should never exceed the configured cap.
    expect(slow.peakPending).toBeLessThanOrEqual(16);
    expect(slow.totalProcessed).toBe(BURST_SIZE);
  }, 30_000);

  it("memory analysis: per-request overhead breakdown", () => {
    // This is a documentation test — computes theoretical memory cost.
    const samplesPerBatch = 100_000;
    const bytesPerBatch =
      samplesPerBatch * 8 + // BigInt64Array (timestamps)
      samplesPerBatch * 8; // Float64Array (values)

    const envelopeOverhead = 300; // labels + metadata + promise
    const totalPerRequest = bytesPerBatch + envelopeOverhead;

    // With structured-clone, the message queue holds a COPY.
    // So N in-flight = N * totalPerRequest on both threads.
    const withoutBp = BURST_SIZE * totalPerRequest;
    const withBp = 64 * totalPerRequest; // default max

    // Just verify the math makes sense and log it.
    expect(withoutBp).toBeGreaterThan(withBp);

    // Log for human consumption.
    const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
    console.log("\n=== Memory analysis (structured-clone, 100k samples/batch) ===");
    console.log(`  Per-batch payload: ${fmt(bytesPerBatch)}`);
    console.log(`  Per-request total: ${fmt(totalPerRequest)}`);
    console.log(`  ${BURST_SIZE} in-flight (no BP): ${fmt(withoutBp)}`);
    console.log(`  64 in-flight (default BP): ${fmt(withBp)}`);
    console.log(`  Reduction: ${((1 - withBp / withoutBp) * 100).toFixed(0)}%`);

    // With transferable, sender side is ~0 after postMessage.
    // But worker side still accumulates until drain.
    console.log("\n=== With transferable ===");
    console.log("  Sender memory after postMessage: ~0 (buffers neutered)");
    console.log(`  Worker queue accumulation: still ${fmt(BURST_SIZE * bytesPerBatch)}`);
    console.log("  → Backpressure protects the WORKER heap, not just the sender.");
  });
});
