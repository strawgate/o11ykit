/**
 * Shared internal utilities for o11ylogsdb codecs.
 *
 * Consolidates functions that were previously duplicated across
 * chunk.ts, codec-columnar.ts, codec-typed.ts, and codec-drain.ts.
 */

export { anyValueToJson, jsonToAnyValue } from "stardb";

import { anyValueToJson, type ByteBuf, bytesToHex, hexToBytes, jsonToAnyValue } from "stardb";
import { PARAM_STR } from "./drain.js";
import type { KeyValue, LogRecord, SeverityText } from "./types.js";

/**
 * Given a Drain template (with PARAM_STR wildcards) and the tokenized
 * input, extract just the variable tokens that correspond to wildcards.
 */
export function extractVarsAgainstTemplate(
  template: readonly string[],
  tokens: readonly string[]
): string[] {
  const out: string[] = [];
  for (let i = 0; i < template.length; i++) {
    if (template[i] === PARAM_STR) out.push(tokens[i] ?? "");
  }
  return out;
}

// ─── Sidecar NDJSON ──────────────────────────────────────────────────

/** Body-kind marker indicating the sidecar must carry the body. */
const KIND_OTHER = 2;

const enc = new TextEncoder();

/**
 * Encode the sidecar NDJSON section for records whose timestamps,
 * severity numbers, and bodies are handled by columnar columns.
 * The sidecar carries auxiliary fields: severityText, attributes,
 * observedTimeUnixNano, flags, traceId, spanId, eventName, droppedAttributesCount.
 *
 * @param kinds - per-record body-kind array (KIND_OTHER = 2 means body goes to sidecar)
 */
export function encodeSidecar(
  records: readonly LogRecord[],
  kinds: readonly number[],
  buf: ByteBuf
): void {
  const n = records.length;
  const sidecarLines: string[] = [];
  let sidecarHasContent = false;
  for (let i = 0; i < n; i++) {
    const r = records[i] as LogRecord;
    const side: Record<string, unknown> = {};
    if (kinds[i] === KIND_OTHER) {
      side.b = anyValueToJson(r.body);
      sidecarHasContent = true;
    }
    if (r.severityText && r.severityText !== "INFO") {
      side.st = r.severityText;
      sidecarHasContent = true;
    }
    if (r.attributes && r.attributes.length > 0) {
      side.a = r.attributes.map((kv) => ({ k: kv.key, v: anyValueToJson(kv.value) }));
      sidecarHasContent = true;
    }
    if (r.observedTimeUnixNano !== undefined) {
      side.o = r.observedTimeUnixNano.toString();
      sidecarHasContent = true;
    }
    if (r.flags !== undefined) {
      side.f = r.flags;
      sidecarHasContent = true;
    }
    if (r.traceId) {
      side.ti = bytesToHex(r.traceId);
      sidecarHasContent = true;
    }
    if (r.spanId) {
      side.si = bytesToHex(r.spanId);
      sidecarHasContent = true;
    }
    if (r.eventName) {
      side.e = r.eventName;
      sidecarHasContent = true;
    }
    if (r.droppedAttributesCount) {
      side.d = r.droppedAttributesCount;
      sidecarHasContent = true;
    }
    sidecarLines.push(JSON.stringify(side));
  }
  if (!sidecarHasContent) {
    buf.writeUvarint(0);
  } else {
    const sidecar = enc.encode(`${sidecarLines.join("\n")}\n`);
    buf.writeUvarint(sidecar.length);
    buf.writeBytes(sidecar);
  }
}

/** Parsed sidecar entry — JSON object with optional fields. */
export interface SidecarEntry {
  b?: unknown;
  st?: string;
  a?: Array<{ k: string; v: unknown }>;
  o?: string;
  f?: number;
  ti?: string;
  si?: string;
  e?: string;
  d?: number;
}

/**
 * Reconstruct auxiliary LogRecord fields from a parsed sidecar entry.
 * Mutates `rec` in-place, adding optional fields.
 */
export function applySidecar(rec: LogRecord, side: SidecarEntry): void {
  if (side.st) rec.severityText = side.st as SeverityText | string;
  else rec.severityText = "INFO";
  const attributes: KeyValue[] = side.a
    ? side.a.map((kv) => ({ key: kv.k, value: jsonToAnyValue(kv.v) }))
    : [];
  rec.attributes = attributes;
  if (side.o !== undefined) rec.observedTimeUnixNano = BigInt(side.o);
  if (side.f !== undefined) rec.flags = side.f;
  if (side.ti) rec.traceId = hexToBytes(side.ti);
  if (side.si) rec.spanId = hexToBytes(side.si);
  if (side.e) rec.eventName = side.e;
  if (side.d) rec.droppedAttributesCount = side.d;
}
