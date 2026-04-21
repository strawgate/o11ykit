import { beforeEach, describe, expect, it, vi } from "vitest";

import { O11yWorkerRuntime } from "../src/worker.js";
import type { RequestEnvelope, ResponseEnvelope } from "../src/worker-protocol.js";

// ── Mock endpoint ───────────────────────────────────────────────────

type EventListener = (event: { data: unknown }) => void;
type OnListener = (data: unknown) => void;

function createMockEndpoint(mode: "addEventListener" | "on" = "addEventListener") {
  const posted: Array<{ message: unknown; transfer?: ArrayBufferLike[] }> = [];
  let eventListener: EventListener | undefined;
  let onListener: OnListener | undefined;

  const endpoint = {
    postMessage(message: unknown, transfer?: ArrayBufferLike[]): void {
      posted.push({ message, transfer });
    },
    ...(mode === "addEventListener"
      ? {
          addEventListener(_type: string, listener: EventListener): void {
            eventListener = listener;
          },
        }
      : {
          on(_type: string, listener: OnListener): void {
            onListener = listener;
          },
        }),
  };

  return {
    endpoint,
    posted,
    /** Simulate receiving a message (shape depends on mode). */
    send(data: unknown): void {
      if (eventListener) {
        eventListener({ data });
      } else if (onListener) {
        onListener(data);
      }
    },
    /** Send a properly wrapped RequestEnvelope. */
    sendRequest(envelope: RequestEnvelope): void {
      this.send(envelope);
    },
  };
}

/** Wait for the runtime to post a response (polls for up to 100ms). */
async function waitForResponse(
  mock: ReturnType<typeof createMockEndpoint>,
  afterIndex = -1
): Promise<ResponseEnvelope> {
  const target = afterIndex >= 0 ? afterIndex + 1 : mock.posted.length;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (mock.posted.length > target || (afterIndex < 0 && mock.posted.length > 0 && i > 0)) {
      break;
    }
  }
  const last = mock.posted[mock.posted.length - 1];
  if (!last) throw new Error("No response received within timeout");
  return last.message as ResponseEnvelope;
}

function makeRequest(id: number, payload: RequestEnvelope["payload"]): RequestEnvelope {
  return { id, kind: "request", payload };
}

describe("O11yWorkerRuntime", () => {
  let mock: ReturnType<typeof createMockEndpoint>;
  let runtime: O11yWorkerRuntime;

  beforeEach(() => {
    mock = createMockEndpoint();
    // biome-ignore lint/suspicious/noExplicitAny: test code
    runtime = new O11yWorkerRuntime(mock.endpoint as any);
    runtime.start();
  });

  // ── init ──────────────────────────────────────────────────────

  describe("init", () => {
    it("responds with backend name", async () => {
      mock.sendRequest(makeRequest(1, { type: "init", chunkSize: 128 }));
      const resp = await waitForResponse(mock);

      expect(resp.kind).toBe("response");
      expect(resp.id).toBe(1);
      expect(resp.payload.ok).toBe(true);
      expect(resp.payload.type).toBe("init");
      if (resp.payload.type === "init") {
        expect(typeof resp.payload.backend).toBe("string");
      }
    });

    it("uses default chunk size when omitted", async () => {
      mock.sendRequest(makeRequest(1, { type: "init" }));
      const resp = await waitForResponse(mock);

      expect(resp.payload.ok).toBe(true);
      expect(resp.payload.type).toBe("init");
    });
  });

  // ── ingest ────────────────────────────────────────────────────

  describe("ingest", () => {
    it("ingests samples and returns series info", async () => {
      // Init first
      mock.sendRequest(makeRequest(1, { type: "init", chunkSize: 1024 }));
      await waitForResponse(mock);

      const timestamps = BigInt64Array.from([1000n, 2000n, 3000n]);
      const values = new Float64Array([1.0, 2.0, 3.0]);

      mock.sendRequest(
        makeRequest(2, {
          type: "ingest",
          labels: [
            ["__name__", "cpu"],
            ["host", "a"],
          ],
          timestamps,
          values,
        })
      );
      const resp = await waitForResponse(mock);

      expect(resp.payload.ok).toBe(true);
      expect(resp.payload.type).toBe("ingest");
      if (resp.payload.type === "ingest") {
        expect(resp.payload.seriesId).toBeTypeOf("number");
        expect(resp.payload.ingestedSamples).toBe(3);
      }
    });
  });

  // ── query ─────────────────────────────────────────────────────

  describe("query", () => {
    it("returns query results after ingesting data", async () => {
      // Init
      mock.sendRequest(makeRequest(1, { type: "init", chunkSize: 1024 }));
      await waitForResponse(mock);

      // Ingest
      mock.sendRequest(
        makeRequest(2, {
          type: "ingest",
          labels: [
            ["__name__", "cpu"],
            ["host", "web-01"],
          ],
          timestamps: BigInt64Array.from([100n, 200n, 300n]),
          values: new Float64Array([10, 20, 30]),
        })
      );
      await waitForResponse(mock);

      // Query
      mock.sendRequest(
        makeRequest(3, {
          type: "query",
          opts: { metric: "cpu", start: 0n, end: 1000n },
        })
      );
      const resp = await waitForResponse(mock);

      expect(resp.payload.ok).toBe(true);
      expect(resp.payload.type).toBe("query");
      if (resp.payload.type === "query") {
        expect(resp.payload.result.series.length).toBeGreaterThanOrEqual(1);
        expect(resp.payload.result.scannedSamples).toBeGreaterThan(0);
      }
    });

    it("returns empty result for non-matching metric", async () => {
      mock.sendRequest(makeRequest(1, { type: "init" }));
      await waitForResponse(mock);

      mock.sendRequest(
        makeRequest(2, {
          type: "query",
          opts: { metric: "nonexistent", start: 0n, end: 1000n },
        })
      );
      const resp = await waitForResponse(mock);

      expect(resp.payload.ok).toBe(true);
      if (resp.payload.type === "query") {
        expect(resp.payload.result.series).toEqual([]);
      }
    });
  });

  // ── stats ─────────────────────────────────────────────────────

  describe("stats", () => {
    it("returns zero stats on fresh store", async () => {
      mock.sendRequest(makeRequest(1, { type: "init" }));
      await waitForResponse(mock);

      mock.sendRequest(makeRequest(2, { type: "stats" }));
      const resp = await waitForResponse(mock);

      expect(resp.payload.ok).toBe(true);
      expect(resp.payload.type).toBe("stats");
      if (resp.payload.type === "stats") {
        expect(resp.payload.stats.seriesCount).toBe(0);
        expect(resp.payload.stats.sampleCount).toBe(0);
        expect(resp.payload.stats.memoryBytes).toBeTypeOf("number");
      }
    });

    it("reflects ingested data", async () => {
      mock.sendRequest(makeRequest(1, { type: "init" }));
      await waitForResponse(mock);

      mock.sendRequest(
        makeRequest(2, {
          type: "ingest",
          labels: [["__name__", "mem"]],
          timestamps: BigInt64Array.from([1n, 2n]),
          values: new Float64Array([100, 200]),
        })
      );
      await waitForResponse(mock);

      mock.sendRequest(makeRequest(3, { type: "stats" }));
      const resp = await waitForResponse(mock);

      if (resp.payload.type === "stats") {
        expect(resp.payload.stats.seriesCount).toBe(1);
        expect(resp.payload.stats.sampleCount).toBe(2);
      }
    });
  });

  // ── echo ──────────────────────────────────────────────────────

  describe("echo", () => {
    it("echoes back the byte length", async () => {
      mock.sendRequest(makeRequest(1, { type: "echo", payload: new Uint8Array(512) }));
      const resp = await waitForResponse(mock);

      expect(resp.payload.ok).toBe(true);
      expect(resp.payload.type).toBe("echo");
      if (resp.payload.type === "echo") {
        expect(resp.payload.bytes).toBe(512);
      }
    });

    it("echoes zero bytes for empty payload", async () => {
      mock.sendRequest(makeRequest(1, { type: "echo", payload: new Uint8Array(0) }));
      const resp = await waitForResponse(mock);

      if (resp.payload.type === "echo") {
        expect(resp.payload.bytes).toBe(0);
      }
    });
  });

  // ── batch-ingest ──────────────────────────────────────────────

  describe("batch-ingest", () => {
    it("ingests multiple series in a single message", async () => {
      // Init first
      mock.sendRequest(makeRequest(1, { type: "init", chunkSize: 1024 }));
      await waitForResponse(mock);

      // Pack 2 series: series A (3 pts), series B (2 pts)
      const allTimestampsMs = new Float64Array([100, 200, 300, 400, 500]);
      const allValues = new Float64Array([1.0, 2.0, 3.0, 10.0, 20.0]);
      const offsets = new Uint32Array([0, 3, 3, 2]);

      mock.sendRequest(
        makeRequest(2, {
          type: "batch-ingest",
          count: 2,
          labels: [
            [
              ["__name__", "cpu"],
              ["host", "a"],
            ],
            [
              ["__name__", "mem"],
              ["host", "b"],
            ],
          ],
          allTimestampsMs,
          allValues,
          offsets,
        })
      );
      const resp = await waitForResponse(mock);

      expect(resp.payload.ok).toBe(true);
      expect(resp.payload.type).toBe("batch-ingest");
      if (resp.payload.type === "batch-ingest") {
        expect(resp.payload.seriesCount).toBe(2);
        expect(resp.payload.totalSamples).toBe(5);
      }

      // Verify stats reflect the ingested data
      mock.sendRequest(makeRequest(3, { type: "stats" }));
      const statsResp = await waitForResponse(mock);
      if (statsResp.payload.type === "stats") {
        expect(statsResp.payload.stats.seriesCount).toBe(2);
        expect(statsResp.payload.stats.sampleCount).toBe(5);
      }
    });

    it("handles empty batch (all zero-length series)", async () => {
      mock.sendRequest(makeRequest(1, { type: "init" }));
      await waitForResponse(mock);

      mock.sendRequest(
        makeRequest(2, {
          type: "batch-ingest",
          count: 1,
          labels: [[["__name__", "empty"]]],
          allTimestampsMs: new Float64Array(0),
          allValues: new Float64Array(0),
          offsets: new Uint32Array([0, 0]),
        })
      );
      const resp = await waitForResponse(mock);

      expect(resp.payload.ok).toBe(true);
      if (resp.payload.type === "batch-ingest") {
        expect(resp.payload.totalSamples).toBe(0);
      }
    });
  });

  // ── close ─────────────────────────────────────────────────────

  describe("close", () => {
    it("responds with close acknowledgement", async () => {
      mock.sendRequest(makeRequest(1, { type: "close" }));
      const resp = await waitForResponse(mock);

      expect(resp.payload.ok).toBe(true);
      expect(resp.payload.type).toBe("close");
    });
  });

  // ── Meta passthrough ──────────────────────────────────────────

  describe("meta passthrough", () => {
    it("includes meta in response when request has meta", async () => {
      const req: RequestEnvelope = {
        id: 1,
        kind: "request",
        payload: { type: "echo", payload: new Uint8Array(1) },
        meta: { strategy: "transferable", sentAt: 12345 },
      };
      mock.sendRequest(req);
      const resp = await waitForResponse(mock);

      expect(resp.meta).toEqual({ strategy: "transferable", sentAt: 12345 });
    });

    it("omits meta in response when request has no meta", async () => {
      mock.sendRequest(makeRequest(1, { type: "close" }));
      const resp = await waitForResponse(mock);

      // ok() omits meta when undefined
      expect(resp.meta).toBeUndefined();
    });
  });

  // ── Error handling ────────────────────────────────────────────

  describe("error handling", () => {
    it("ignores non-request messages", async () => {
      mock.send(null);
      mock.send(42);
      mock.send("garbage");
      mock.send({ kind: "response", id: 1, payload: {} });

      // No responses should have been posted
      expect(mock.posted.length).toBe(0);
    });

    it("ignores messages without kind=request", async () => {
      mock.send({
        id: 1,
        kind: "not-request",
        payload: { type: "echo", payload: new Uint8Array(1) },
      });
      expect(mock.posted.length).toBe(0);
    });

    it("unwraps event.data from addEventListener messages", async () => {
      // All sendRequest calls already exercise the event.data unwrap path
      // (mock.send wraps in {data: ...} for addEventListener endpoints).
      // Verify explicitly with a high request id.
      mock.sendRequest(makeRequest(99, { type: "echo", payload: new Uint8Array(16) }));
      const resp = await waitForResponse(mock, mock.posted.length - 1);
      expect(resp.payload.ok).toBe(true);
      expect(resp.payload.type).toBe("echo");
      expect(resp.id).toBe(99);
    });
  });

  // ── on() endpoint (Node.js worker_threads style) ──────────────

  describe("Node.js-style endpoint (on)", () => {
    it('works with on("message") instead of addEventListener', async () => {
      const onMock = createMockEndpoint("on");
      // biome-ignore lint/suspicious/noExplicitAny: test code
      const rt = new O11yWorkerRuntime(onMock.endpoint as any);
      rt.start();

      onMock.sendRequest(makeRequest(1, { type: "echo", payload: new Uint8Array(64) }));
      const resp = await waitForResponse(onMock);

      expect(resp.payload.ok).toBe(true);
      if (resp.payload.type === "echo") {
        expect(resp.payload.bytes).toBe(64);
      }
    });
  });

  // ── Endpoint without any listener method ──────────────────────

  describe("bad endpoint", () => {
    it("throws when endpoint has neither addEventListener nor on", () => {
      const badEndpoint = {
        postMessage: vi.fn(),
      };

      // biome-ignore lint/suspicious/noExplicitAny: test code
      const rt = new O11yWorkerRuntime(badEndpoint as any);
      expect(() => rt.start()).toThrow("Worker endpoint does not support message listeners.");
    });
  });

  // ── Full round-trip: init → ingest → query → stats → close ───

  describe("full lifecycle", () => {
    it("supports a complete init → ingest → query → stats → close cycle", async () => {
      // Init
      mock.sendRequest(makeRequest(1, { type: "init", chunkSize: 640 }));
      const initResp = await waitForResponse(mock);
      expect(initResp.payload.type).toBe("init");

      // Ingest two series
      mock.sendRequest(
        makeRequest(2, {
          type: "ingest",
          labels: [
            ["__name__", "http_requests"],
            ["method", "GET"],
          ],
          timestamps: BigInt64Array.from([100n, 200n, 300n]),
          values: new Float64Array([1, 2, 3]),
        })
      );
      await waitForResponse(mock);

      mock.sendRequest(
        makeRequest(3, {
          type: "ingest",
          labels: [
            ["__name__", "http_requests"],
            ["method", "POST"],
          ],
          timestamps: BigInt64Array.from([100n, 200n]),
          values: new Float64Array([10, 20]),
        })
      );
      await waitForResponse(mock);

      // Query
      mock.sendRequest(
        makeRequest(4, {
          type: "query",
          opts: { metric: "http_requests", start: 0n, end: 1000n },
        })
      );
      const queryResp = await waitForResponse(mock);
      if (queryResp.payload.type === "query") {
        expect(queryResp.payload.result.series.length).toBe(2);
        expect(queryResp.payload.result.scannedSamples).toBe(5);
      }

      // Stats
      mock.sendRequest(makeRequest(5, { type: "stats" }));
      const statsResp = await waitForResponse(mock);
      if (statsResp.payload.type === "stats") {
        expect(statsResp.payload.stats.seriesCount).toBe(2);
        expect(statsResp.payload.stats.sampleCount).toBe(5);
      }

      // Close
      mock.sendRequest(makeRequest(6, { type: "close" }));
      const closeResp = await waitForResponse(mock);
      expect(closeResp.payload.type).toBe("close");
    });
  });
});
