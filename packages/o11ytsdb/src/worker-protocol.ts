import type { QueryOpts, QueryResult } from "./types.js";

export type RequestId = number;

export type TransferStrategy = "structured-clone" | "transferable" | "shared-array-buffer";

export type LabelEntries = Array<[string, string]>;

export interface ProtocolMeta {
  strategy?: TransferStrategy;
  sentAt?: number;
}

export interface InitRequest {
  type: "init";
  chunkSize?: number;
  /** Decimal precision for value quantization (e.g. 3 → round to 0.001). */
  precision?: number;
}

export interface IngestRequest {
  type: "ingest";
  labels: LabelEntries;
  timestamps: BigInt64Array;
  values: Float64Array;
}

/**
 * Batch ingest: all series from an OTLP payload in a single message.
 *
 * Timestamps are millisecond Float64 — the worker converts to nanosecond
 * BigInt64Array (WASM-accelerated when available). This avoids BigInt
 * allocation on the main thread entirely.
 *
 * Layout: `allTimestampsMs` and `allValues` are flat-packed; `offsets` is
 * a Uint32Array of `[offset0, len0, offset1, len1, ...]` pairs.
 */
export interface BatchIngestRequest {
  type: "batch-ingest";
  count: number;
  labels: LabelEntries[];
  allTimestampsMs: Float64Array;
  allValues: Float64Array;
  offsets: Uint32Array;
}

export interface QueryRequest {
  type: "query";
  opts: QueryOpts;
}

export interface StatsRequest {
  type: "stats";
}

export interface CloseRequest {
  type: "close";
}

export interface EchoRequest {
  type: "echo";
  payload: Uint8Array;
}

export type WorkerRequest =
  | InitRequest
  | IngestRequest
  | BatchIngestRequest
  | QueryRequest
  | StatsRequest
  | CloseRequest
  | EchoRequest;

export interface InitResponse {
  ok: true;
  type: "init";
  backend: string;
}

export interface IngestResponse {
  ok: true;
  type: "ingest";
  seriesId: number;
  ingestedSamples: number;
}

export interface BatchIngestResponse {
  ok: true;
  type: "batch-ingest";
  seriesCount: number;
  totalSamples: number;
}

export interface QueryResponse {
  ok: true;
  type: "query";
  result: QueryResult;
}

export interface StatsResponse {
  ok: true;
  type: "stats";
  stats: {
    seriesCount: number;
    sampleCount: number;
    memoryBytes: number;
  };
}

export interface EchoResponse {
  ok: true;
  type: "echo";
  bytes: number;
}

export interface CloseResponse {
  ok: true;
  type: "close";
}

export interface ErrorResponse {
  ok: false;
  type: "error";
  error: string;
  stack?: string;
}

export type WorkerResponse =
  | InitResponse
  | IngestResponse
  | BatchIngestResponse
  | QueryResponse
  | StatsResponse
  | EchoResponse
  | CloseResponse
  | ErrorResponse;

export interface RequestEnvelope<T extends WorkerRequest = WorkerRequest> {
  id: RequestId;
  kind: "request";
  payload: T;
  meta?: ProtocolMeta;
}

export interface ResponseEnvelope<T extends WorkerResponse = WorkerResponse> {
  id: RequestId;
  kind: "response";
  payload: T;
  meta?: ProtocolMeta;
}

export function ok<T extends WorkerResponse>(
  id: RequestId,
  payload: T,
  meta?: ProtocolMeta
): ResponseEnvelope<T> {
  return meta ? { id, kind: "response", payload, meta } : { id, kind: "response", payload };
}

export function err(
  id: RequestId,
  error: unknown,
  meta?: ProtocolMeta
): ResponseEnvelope<ErrorResponse> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const payload: ErrorResponse = stack
    ? { ok: false, type: "error", error: message, stack }
    : { ok: false, type: "error", error: message };
  return meta ? { id, kind: "response", payload, meta } : { id, kind: "response", payload };
}

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ResponseEnvelope>;
  return candidate.kind === "response" && typeof candidate.id === "number" && !!candidate.payload;
}

export function labelsFromEntries(entries: LabelEntries): ReadonlyMap<string, string> {
  return new Map<string, string>(entries);
}
