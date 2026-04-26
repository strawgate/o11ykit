/**
 * Body shape classifier — picks `BodyKind` per record at ingest.
 *
 * The default classifier is intentionally simple:
 *   - `bytesValue` (Uint8Array)        → "bytes"
 *   - `kvlistValue` (object)            → "kvlist"
 *   - `arrayValue` (array)              → "kvlist"        // treated like a tiny map
 *   - non-string primitive              → "primitive"
 *   - string body                       → "freetext" (default)
 *
 * The "templated" classification requires a `TemplateExtractor` to be
 * plugged in (Drain or similar). Without one, all string bodies are
 * `freetext`. That gives us a working pipeline; the M2 deliverable
 * upgrades it.
 */

import type { AnyValue, BodyKind, LogRecord } from "./types.js";

export interface TemplateExtractor {
  /** Returns a non-negative template id if `s` matches a known template. */
  matchTemplate(s: string): { templateId: number; vars: string[] } | undefined;
  /** Returns the same shape, plus may add a new template for `s`. */
  matchOrAdd(s: string): { templateId: number; vars: string[]; isNew: boolean };
  /** Number of distinct templates currently held. */
  templateCount(): number;
  /** Iterator over `(id, template)` pairs for chunk header serialization. */
  templates(): Iterable<{ id: number; template: string }>;
}

export interface BodyClassifier {
  classify(record: LogRecord): BodyKind;
}

/** Default classifier — no template extractor; all string bodies are freetext. */
export const defaultClassifier: BodyClassifier = {
  classify(record): BodyKind {
    return classifyShape(record.body);
  },
};

/** Classifier that consults a `TemplateExtractor` for string bodies. */
export class TemplatedClassifier implements BodyClassifier {
  constructor(private readonly extractor: TemplateExtractor) {}
  classify(record: LogRecord): BodyKind {
    const shape = classifyShape(record.body);
    if (shape !== "freetext") return shape;
    // String body: try to match a template.
    const s = record.body as string;
    return this.extractor.matchTemplate(s) ? "templated" : "freetext";
  }
}

function classifyShape(body: AnyValue): BodyKind {
  if (body === null) return "primitive";
  if (typeof body === "string") return "freetext";
  if (typeof body === "number") return "primitive";
  if (typeof body === "bigint") return "primitive";
  if (typeof body === "boolean") return "primitive";
  if (body instanceof Uint8Array) return "bytes";
  if (Array.isArray(body)) return "kvlist";
  if (typeof body === "object") return "kvlist";
  return "primitive";
}
