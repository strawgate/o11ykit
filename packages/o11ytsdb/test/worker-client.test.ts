import { beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/correctness/noUnusedImports: test code
import { WorkerClient, type WorkerClientOptions } from "../src/worker-client.js";
import type {
  RequestEnvelope,
  ResponseEnvelope,
  // biome-ignore lint/correctness/noUnusedImports: test code
  TransferStrategy,
  WorkerResponse,
} from "../src/worker-protocol.js";

// ── Mock worker ─────────────────────────────────────────────────────

type MessageListener = (event: { data: unknown }) => void;

/** Minimal mock that captures postMessage calls and lets us send responses. */
function createMockWorker() {
  const messageListeners: MessageListener[] = [];
  const posted: Array<{ message: unknown; transfer?: ArrayBufferLike[] }> = [];

  return {
    /** The WorkerLike interface used by WorkerClient. */
    worker: {
      postMessage(message: unknown, transfer?: ArrayBufferLike[]): void {
        posted.push({ message, transfer });
      },
      addEventListener(type: string, listener: MessageListener): void {
        if (type === "message") messageListeners.push(listener);
        // Silently accept other types (e.g. "error") without storing them,
        // since the mock doesn't simulate worker crashes.
      },
      terminate: vi.fn(),
    },
    /** Simulate receiving a message from the "worker". */
    respond(data: unknown): void {
      for (const listener of messageListeners) listener({ data });
    },
    /** Auto-respond to the next postMessage with a success envelope. */
    autoRespond(payload: WorkerResponse): void {
      // biome-ignore lint/correctness/noUnusedVariables: test code
      const orig = posted.length;
      // We'll patch postMessage to respond immediately.
      // biome-ignore lint/correctness/noUnusedVariables: test code
      const realPost = posted;

      const origPostMessage = this.worker.postMessage;
      this.worker.postMessage = (message: unknown, transfer?: ArrayBufferLike[]) => {
        origPostMessage.call(this.worker, message, transfer);
        const req = message as RequestEnvelope;
        const response: ResponseEnvelope = {
          id: req.id,
          kind: "response",
          payload,
        };
        this.respond(response);
      };
    },
    posted,
  };
}

describe("WorkerClient", () => {
  let mock: ReturnType<typeof createMockWorker>;
  let client: WorkerClient;

  beforeEach(() => {
    mock = createMockWorker();
    client = new WorkerClient({ worker: mock.worker });
  });

  // ── init() ────────────────────────────────────────────────────

  describe("init()", () => {
    it("sends an init request and resolves with backend name", async () => {
      mock.autoRespond({ ok: true, type: "init", backend: "column" });

      const result = await client.init({ chunkSize: 640 });
      expect(result).toEqual({ backend: "column" });

      const envelope = mock.posted[0].message as RequestEnvelope;
      expect(envelope.kind).toBe("request");
      expect(envelope.payload).toEqual({ type: "init", chunkSize: 640 });
    });

    it("sends init without chunkSize when omitted", async () => {
      mock.autoRespond({ ok: true, type: "init", backend: "column" });

      await client.init();
      const envelope = mock.posted[0].message as RequestEnvelope;
      expect(envelope.payload).toEqual({ type: "init" });
    });

    it("throws on error response", async () => {
      mock.autoRespond({ ok: false, type: "error", error: "init failed" });

      await expect(client.init()).rejects.toThrow("init failed");
    });
  });

  // ── ingest() ──────────────────────────────────────────────────

  describe("ingest()", () => {
    it("sends ingest request with labels, timestamps, values", async () => {
      mock.autoRespond({ ok: true, type: "ingest", seriesId: 0, ingestedSamples: 3 });

      const labels = new Map([
        ["__name__", "cpu"],
        ["host", "a"],
      ]);
      const timestamps = BigInt64Array.from([1n, 2n, 3n]);
      const values = new Float64Array([10, 20, 30]);

      const result = await client.ingest(labels, timestamps, values);
      expect(result).toEqual({ seriesId: 0, ingestedSamples: 3 });

      const envelope = mock.posted[0].message as RequestEnvelope;
      expect(envelope.payload.type).toBe("ingest");
    });

    it("includes transferables for transferable strategy", async () => {
      mock.autoRespond({ ok: true, type: "ingest", seriesId: 0, ingestedSamples: 1 });

      const timestamps = BigInt64Array.from([1n]);
      const values = new Float64Array([1]);

      await client.ingest(new Map([["k", "v"]]), timestamps, values);

      const transfer = mock.posted[0].transfer;
      expect(transfer).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: test code
      expect(transfer!.length).toBe(2);
    });

    it("omits transferables for structured-clone strategy", async () => {
      mock = createMockWorker();
      client = new WorkerClient({ worker: mock.worker, transferStrategy: "structured-clone" });
      mock.autoRespond({ ok: true, type: "ingest", seriesId: 0, ingestedSamples: 1 });

      const timestamps = BigInt64Array.from([1n]);
      const values = new Float64Array([1]);

      await client.ingest(new Map([["k", "v"]]), timestamps, values);

      const transfer = mock.posted[0].transfer;
      expect(transfer).toEqual([]);
    });

    it("throws on error response", async () => {
      mock.autoRespond({ ok: false, type: "error", error: "ingest fail" });

      await expect(
        client.ingest(new Map(), BigInt64Array.from([1n]), new Float64Array([1]))
      ).rejects.toThrow("ingest fail");
    });
  });

  // ── query() ───────────────────────────────────────────────────

  describe("query()", () => {
    it("sends query and returns result", async () => {
      const queryResult = { series: [], scannedSeries: 0, scannedSamples: 0 };
      mock.autoRespond({ ok: true, type: "query", result: queryResult });

      const result = await client.query({
        metric: "cpu",
        start: 0n,
        end: 100n,
      });
      expect(result).toEqual(queryResult);
    });

    it("throws on error response", async () => {
      mock.autoRespond({ ok: false, type: "error", error: "query fail" });

      await expect(client.query({ metric: "cpu", start: 0n, end: 100n })).rejects.toThrow(
        "query fail"
      );
    });
  });

  // ── stats() ───────────────────────────────────────────────────

  describe("stats()", () => {
    it("returns stats from worker", async () => {
      mock.autoRespond({
        ok: true,
        type: "stats",
        stats: { seriesCount: 10, sampleCount: 1000, memoryBytes: 4096 },
      });

      const result = await client.stats();
      expect(result).toEqual({ seriesCount: 10, sampleCount: 1000, memoryBytes: 4096 });
    });
  });

  // ── echo() ────────────────────────────────────────────────────

  describe("echo()", () => {
    it("sends echo and returns byte count", async () => {
      mock.autoRespond({ ok: true, type: "echo", bytes: 256 });

      const result = await client.echo(new Uint8Array(256));
      expect(result).toBe(256);
    });

    it("uses transferable strategy by default", async () => {
      mock.autoRespond({ ok: true, type: "echo", bytes: 8 });

      const payload = new Uint8Array(8);
      await client.echo(payload);

      const transfer = mock.posted[0].transfer;
      expect(transfer).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: test code
      expect(transfer!.length).toBe(1);
    });

    it("skips transferables when strategy is structured-clone", async () => {
      mock.autoRespond({ ok: true, type: "echo", bytes: 8 });

      const payload = new Uint8Array(8);
      await client.echo(payload, "structured-clone");

      const transfer = mock.posted[0].transfer;
      expect(transfer).toEqual([]);
    });
  });

  // ── close() ───────────────────────────────────────────────────

  describe("close()", () => {
    it("sends close and calls terminate", async () => {
      mock.autoRespond({ ok: true, type: "close" });

      await client.close();
      expect(mock.worker.terminate).toHaveBeenCalled();
    });

    it("throws on error response", async () => {
      mock.autoRespond({ ok: false, type: "error", error: "close fail" });

      await expect(client.close()).rejects.toThrow("close fail");
    });
  });

  // ── Request IDs ───────────────────────────────────────────────

  describe("request IDs", () => {
    it("increments request IDs across calls", async () => {
      mock.autoRespond({
        ok: true,
        type: "stats",
        stats: { seriesCount: 0, sampleCount: 0, memoryBytes: 0 },
      });

      await client.stats();
      await client.stats();
      await client.stats();

      const ids = mock.posted.map((p) => (p.message as RequestEnvelope).id);
      expect(ids).toEqual([1, 2, 3]);
    });
  });

  // ── Meta ──────────────────────────────────────────────────────

  describe("protocol meta", () => {
    it("includes strategy and sentAt in meta", async () => {
      mock.autoRespond({ ok: true, type: "close" });
      await client.close();

      const envelope = mock.posted[0].message as RequestEnvelope;
      expect(envelope.meta).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: test code
      expect(envelope.meta!.strategy).toBe("transferable");
      // biome-ignore lint/style/noNonNullAssertion: test code
      expect(typeof envelope.meta!.sentAt).toBe("number");
    });
  });

  // ── Unmatched responses ───────────────────────────────────────

  describe("message handling", () => {
    it("ignores non-response messages", () => {
      // Should not throw
      mock.respond({ kind: "request", id: 1, payload: { type: "stats" } });
      mock.respond(null);
      mock.respond(42);
      mock.respond("garbage");
    });

    it("ignores responses with unknown IDs", () => {
      mock.respond({
        id: 9999,
        kind: "response",
        payload: { ok: true, type: "close" },
      });
      // No pending request with id 9999 — should silently ignore
    });
  });

  // ── Worker without terminate ──────────────────────────────────

  describe("worker without terminate()", () => {
    it("does not throw when terminate is undefined", async () => {
      const workerNoTerminate = {
        postMessage: vi.fn(),
        // biome-ignore lint/correctness/noUnusedFunctionParameters: test code
        addEventListener: vi.fn((_type: string, listener: MessageListener) => {
          // store for later
        }),
      };

      // We need to wire up manually
      let capturedListener: MessageListener | undefined;
      workerNoTerminate.addEventListener.mockImplementation(
        (type: string, listener: MessageListener) => {
          if (type === "message") capturedListener = listener;
        }
      );

      const c = new WorkerClient({ worker: workerNoTerminate });

      // Auto-respond via the captured listener
      workerNoTerminate.postMessage.mockImplementation((message: unknown) => {
        const req = message as RequestEnvelope;
        // biome-ignore lint/style/noNonNullAssertion: test code
        capturedListener!({
          data: { id: req.id, kind: "response", payload: { ok: true, type: "close" } },
        });
      });

      await c.close(); // should not throw despite no terminate
    });
  });

  // ── Error handling ──────────────────────────────────────────────

  describe("error handling", () => {
    it("rejects pending RPCs on worker error", async () => {
      let errorListener: ((event: unknown) => void) | undefined;
      const errorWorker = {
        postMessage: vi.fn(),
        addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
          if (type === "error") errorListener = listener;
        }),
        terminate: vi.fn(),
      };

      const c = new WorkerClient({ worker: errorWorker });
      const promise = c.stats();

      // Simulate a worker error
      // biome-ignore lint/style/noNonNullAssertion: test code
      errorListener!({ message: "Worker crashed" });

      await expect(promise).rejects.toThrow("Worker crashed");
    });

    it("rejects subsequent calls after worker error", async () => {
      let errorListener: ((event: unknown) => void) | undefined;
      const errorWorker = {
        postMessage: vi.fn(),
        addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
          if (type === "error") errorListener = listener;
        }),
        terminate: vi.fn(),
      };

      const c = new WorkerClient({ worker: errorWorker });

      // biome-ignore lint/style/noNonNullAssertion: test code
      errorListener!({ message: "Worker crashed" });

      await expect(c.stats()).rejects.toThrow("WorkerClient is closed");
    });

    it("cleans up pending map on postMessage throw", async () => {
      const origPostMessage = mock.worker.postMessage;
      mock.worker.postMessage = () => {
        throw new Error("DataCloneError");
      };

      await expect(client.stats()).rejects.toThrow("DataCloneError");

      // Restore original postMessage and auto-respond — subsequent calls should work
      mock.worker.postMessage = origPostMessage;
      mock.autoRespond({
        ok: true,
        type: "stats",
        stats: { seriesCount: 0, sampleCount: 0, memoryBytes: 0 },
      });
      const result = await client.stats();
      expect(result).toEqual({ seriesCount: 0, sampleCount: 0, memoryBytes: 0 });
    });
  });

  // ── Ingest backpressure ───────────────────────────────────────

  describe("ingest backpressure", () => {
    it("limits concurrent ingest calls to maxInflightIngest", async () => {
      // Use maxInflightIngest=2 so the 3rd call must wait
      mock = createMockWorker();
      client = new WorkerClient({ worker: mock.worker, maxInflightIngest: 2 });

      // Track which responses to send manually
      const pendingResponses: Array<(envelope: ResponseEnvelope) => void> = [];
      const origPostMessage = mock.worker.postMessage;
      mock.worker.postMessage = (message: unknown, transfer?: ArrayBufferLike[]) => {
        origPostMessage.call(mock.worker, message, transfer);
        const req = message as RequestEnvelope;
        pendingResponses.push((response: ResponseEnvelope) => {
          mock.respond({ ...response, id: req.id });
        });
      };

      const labels = new Map([["__name__", "cpu"]]);
      const mkTs = () => BigInt64Array.from([1n]);
      const mkVals = () => new Float64Array([1]);

      // Fire 3 ingest calls concurrently
      const p1 = client.ingest(labels, mkTs(), mkVals());
      const p2 = client.ingest(labels, mkTs(), mkVals());
      const p3 = client.ingest(labels, mkTs(), mkVals());

      // Allow microtasks to flush so acquired slots post their messages
      await new Promise((r) => setTimeout(r, 0));

      // Only 2 should have been posted (3rd is waiting for semaphore)
      expect(mock.posted.length).toBe(2);
      expect(client.ingestBackpressure.pending).toBe(2);
      expect(client.ingestBackpressure.waiting).toBe(1);

      // Resolve the first request — the 3rd call should now get a slot
      pendingResponses[0]({
        id: (mock.posted[0].message as RequestEnvelope).id,
        kind: "response",
        payload: { ok: true, type: "ingest", seriesId: 0, ingestedSamples: 1 },
      });
      await p1;

      // Allow microtasks to flush so the 3rd ingest acquires its slot and posts
      await new Promise((r) => setTimeout(r, 0));

      expect(mock.posted.length).toBe(3);
      expect(client.ingestBackpressure.waiting).toBe(0);

      // Resolve remaining
      pendingResponses[1]({
        id: (mock.posted[1].message as RequestEnvelope).id,
        kind: "response",
        payload: { ok: true, type: "ingest", seriesId: 0, ingestedSamples: 1 },
      });
      pendingResponses[2]({
        id: (mock.posted[2].message as RequestEnvelope).id,
        kind: "response",
        payload: { ok: true, type: "ingest", seriesId: 0, ingestedSamples: 1 },
      });

      await Promise.all([p2, p3]);
      expect(client.ingestBackpressure.pending).toBe(0);
    });

    it("ingestBackpressure getter returns correct shape", () => {
      mock = createMockWorker();
      client = new WorkerClient({ worker: mock.worker, maxInflightIngest: 16 });

      const bp = client.ingestBackpressure;
      expect(bp).toEqual({ pending: 0, waiting: 0, maxConcurrency: 16 });
    });

    it("defaults maxInflightIngest to 64", () => {
      mock = createMockWorker();
      client = new WorkerClient({ worker: mock.worker });
      expect(client.ingestBackpressure.maxConcurrency).toBe(64);
    });
  });
});
