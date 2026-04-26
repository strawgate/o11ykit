/**
 * `DrainChunkPolicy` — chunk-level body-templating policy that uses
 * Drain to extract templates at chunk-close and replaces each
 * record's string body with a `(template_id, vars[])` reference.
 *
 * The chunk header carries a per-chunk template dictionary (only the
 * templates referenced in this chunk, not the parser's full state),
 * so each chunk is self-describing for decode. The Drain parser
 * itself persists across chunks within the same policy instance —
 * so use one policy per stream if you want stream-isolated template
 * IDs (recommended).
 *
 * This is the M2-validation deliverable wired through the engine's
 * plug-in surface. It demonstrates that:
 *   1. ChunkPolicy.preEncode + postDecode let an experiment swap
 *      the body representation without touching the engine core.
 *   2. The TS Drain port (mirror of the validated Rust port) plugs
 *      cleanly into both `BodyClassifier` and `ChunkPolicy`.
 */

import type { ChunkPolicy } from "./chunk.js";
import { Drain, PARAM_STR, tokenize } from "./drain.js";
import type { AnyValue, LogRecord } from "./types.js";

interface TemplateEntry {
  id: number;
  /** Template tokens joined with single spaces. */
  template: string;
}

interface DrainChunkMeta {
  templates: TemplateEntry[];
}

/** Wire-format placeholder for a templated body. */
interface TemplatedBody {
  $tpl: number;
  $v: string[];
}

/**
 * Configuration for `DrainChunkPolicy`. Most callers want the defaults.
 */
export interface DrainChunkPolicyConfig {
  /** Bytes codec for the body payload. Default `"zstd-19"`. */
  bodyCodec?: string;
  /** Drain instance to share across chunks. Default: a fresh Drain. */
  drain?: Drain;
}

export class DrainChunkPolicy implements ChunkPolicy {
  readonly drain: Drain;
  private readonly bodyCodecName: string;

  constructor(config: DrainChunkPolicyConfig = {}) {
    this.drain = config.drain ?? new Drain();
    this.bodyCodecName = config.bodyCodec ?? "zstd-19";
  }

  bodyCodec(): string {
    return this.bodyCodecName;
  }

  preEncode(records: readonly LogRecord[]): {
    records: readonly LogRecord[];
    meta?: DrainChunkMeta;
  } {
    // Two passes are necessary because Drain templates evolve as more
    // records arrive: a template that's "no wildcards" at the moment
    // record 0 is inserted may be widened to "5 wildcards" by the
    // time record 999 is processed. We can't capture vars at
    // insert-time and expect them to round-trip correctly. Instead:
    //
    //   pass 1: ingest every body into Drain. Record (record_idx →
    //           cluster_id) but ignore the vars Drain returns.
    //   pass 2: now that the Drain state is stable for this chunk,
    //           re-tokenize each body and extract vars against the
    //           current template tokens for that cluster.
    //
    // The chunk's meta carries the template strings as they exist at
    // freeze time. Across chunks, the templates may evolve further;
    // each chunk's meta is self-contained for decode.

    const idsByRecord: Int32Array = new Int32Array(records.length);
    for (let i = 0; i < records.length; i++) {
      const r = records[i] as LogRecord;
      if (typeof r.body !== "string") {
        idsByRecord[i] = -1;
        continue;
      }
      idsByRecord[i] = this.drain.matchOrAdd(r.body).templateId;
    }

    // Snapshot the per-cluster template tokens once for this chunk.
    const templatesById: Map<number, string[]> = new Map();
    const templates: TemplateEntry[] = [];
    const usedIds = new Set<number>();
    for (let i = 0; i < idsByRecord.length; i++) {
      const id = idsByRecord[i] as number;
      if (id >= 0) usedIds.add(id);
    }
    for (const t of this.drain.templates()) {
      if (!usedIds.has(t.id)) continue;
      const tokens = t.template.split(/\s+/).filter((s) => s.length > 0);
      templatesById.set(t.id, tokens);
      templates.push({ id: t.id, template: t.template });
    }

    const transformed: LogRecord[] = new Array(records.length);
    for (let i = 0; i < records.length; i++) {
      const r = records[i] as LogRecord;
      const tplId = idsByRecord[i] as number;
      if (typeof r.body !== "string" || tplId < 0) {
        transformed[i] = r;
        continue;
      }
      const finalTemplate = templatesById.get(tplId);
      if (!finalTemplate) {
        transformed[i] = r;
        continue;
      }
      const tokens = tokenize(r.body);
      const vars: string[] =
        finalTemplate.length === tokens.length
          ? extractVarsAgainstTemplate(finalTemplate, tokens)
          : [];
      const placeholder: AnyValue = { $tpl: tplId, $v: vars };
      transformed[i] = { ...r, body: placeholder };
    }
    return { records: transformed, meta: { templates } };
  }

  postDecode(records: LogRecord[], meta: unknown): LogRecord[] {
    const tplDict = parseMeta(meta);
    if (!tplDict) return records;
    return records.map((r) => {
      const placeholder = asTemplatedBody(r.body);
      if (!placeholder) return r;
      const template = tplDict.get(placeholder.$tpl);
      if (!template) return r;
      const reconstructed = Drain.reconstruct(template, placeholder.$v);
      return { ...r, body: reconstructed };
    });
  }
}

function parseMeta(meta: unknown): Map<number, string[]> | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as { templates?: unknown };
  if (!Array.isArray(m.templates)) return undefined;
  const out = new Map<number, string[]>();
  for (const e of m.templates) {
    if (
      e !== null &&
      typeof e === "object" &&
      typeof (e as TemplateEntry).id === "number" &&
      typeof (e as TemplateEntry).template === "string"
    ) {
      const entry = e as TemplateEntry;
      out.set(
        entry.id,
        entry.template.split(/\s+/).filter((s) => s.length > 0)
      );
    }
  }
  return out;
}

function extractVarsAgainstTemplate(
  template: readonly string[],
  tokens: readonly string[]
): string[] {
  const out: string[] = [];
  for (let i = 0; i < template.length; i++) {
    if (template[i] === PARAM_STR) out.push(tokens[i] ?? "");
  }
  return out;
}

function asTemplatedBody(body: AnyValue): TemplatedBody | undefined {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body instanceof Uint8Array
  ) {
    return undefined;
  }
  const obj = body as { $tpl?: unknown; $v?: unknown };
  if (typeof obj.$tpl === "number" && Array.isArray(obj.$v)) {
    return { $tpl: obj.$tpl, $v: obj.$v as string[] };
  }
  return undefined;
}
