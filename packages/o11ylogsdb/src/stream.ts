/**
 * StreamRegistry — interns (resource, scope) tuples to numeric stream
 * IDs. The chunk pipeline groups records by stream so each chunk's
 * resource and scope are constants in the header at zero per-row cost.
 *
 * Hashing: cheap stable JSON serialization of (resource, scope), then
 * FNV-1a 32-bit. Collisions are detected and disambiguated by a per-id
 * deep-equality check at first sight.
 */

import type { Chunk } from "./chunk.js";
import type { InstrumentationScope, KeyValue, Resource, StreamId } from "./types.js";

interface StreamEntry {
  id: StreamId;
  resource: Resource;
  scope: InstrumentationScope;
  /** Ordered chunk list, oldest first. */
  chunks: Chunk[];
}

export class StreamRegistry {
  private nextId: StreamId = 1;
  private byHash = new Map<number, StreamEntry[]>();
  private byId = new Map<StreamId, StreamEntry>();
  /**
   * Reference-identity fast path: callers who reuse the same Resource
   * / Scope object for every record (the common case for OTLP-batch
   * ingest, where one batch shares one resource/scope) hit a
   * WeakMap lookup instead of full sortedJson canonicalisation.
   *
   * CPU profile evidence: stream.ts:111 (sortDeep) + stream.ts:108
   * (sortedJson) consumed ~2.7% of total ingest CPU on OpenStack-2k
   * before this fast path landed (2026-04-26 CPU profile).
   */
  private byResourceRef: WeakMap<Resource, Map<InstrumentationScope, StreamId>> = new WeakMap();

  /** Resolve or create a stream id for a (resource, scope) pair. */
  intern(resource: Resource, scope: InstrumentationScope): StreamId {
    // Fast path: identical (resource, scope) object references seen
    // before. WeakMap → Map<scope, id> lookup is two pointer chases.
    const refScopeMap = this.byResourceRef.get(resource);
    if (refScopeMap !== undefined) {
      const refId = refScopeMap.get(scope);
      if (refId !== undefined) return refId;
    }
    const h = hashStream(resource, scope);
    const bucket = this.byHash.get(h) ?? [];
    for (const e of bucket) {
      if (deepEqualResource(e.resource, resource) && deepEqualScope(e.scope, scope)) {
        // Cache the reference identity for future calls.
        this.cacheRef(resource, scope, e.id);
        return e.id;
      }
    }
    const entry: StreamEntry = { id: this.nextId++, resource, scope, chunks: [] };
    bucket.push(entry);
    this.byHash.set(h, bucket);
    this.byId.set(entry.id, entry);
    this.cacheRef(resource, scope, entry.id);
    return entry.id;
  }

  private cacheRef(resource: Resource, scope: InstrumentationScope, id: StreamId): void {
    let scopeMap = this.byResourceRef.get(resource);
    if (scopeMap === undefined) {
      scopeMap = new Map();
      this.byResourceRef.set(resource, scopeMap);
    }
    scopeMap.set(scope, id);
  }

  resourceOf(id: StreamId): Resource {
    const e = this.byId.get(id);
    if (!e) throw new Error(`StreamRegistry: unknown id ${id}`);
    return e.resource;
  }

  scopeOf(id: StreamId): InstrumentationScope {
    const e = this.byId.get(id);
    if (!e) throw new Error(`StreamRegistry: unknown id ${id}`);
    return e.scope;
  }

  appendChunk(id: StreamId, chunk: Chunk): void {
    const e = this.byId.get(id);
    if (!e) throw new Error(`StreamRegistry: unknown id ${id}`);
    e.chunks.push(chunk);
  }

  chunksOf(id: StreamId): readonly Chunk[] {
    const e = this.byId.get(id);
    if (!e) throw new Error(`StreamRegistry: unknown id ${id}`);
    return e.chunks;
  }

  ids(): StreamId[] {
    return [...this.byId.keys()];
  }

  size(): number {
    return this.byId.size;
  }
}

// ── Hashing + equality ────────────────────────────────────────────────

function hashStream(resource: Resource, scope: InstrumentationScope): number {
  let h = 2166136261; // FNV offset basis
  h = fnvUpdate(h, sortedJson(canonResource(resource)));
  h = fnvUpdate(h, sortedJson(canonScope(scope)));
  return h >>> 0;
}

function fnvUpdate(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}

function canonResource(r: Resource): Record<string, unknown> {
  return {
    a: kvsToObject(r.attributes),
    d: r.droppedAttributesCount ?? 0,
  };
}

function canonScope(s: InstrumentationScope): Record<string, unknown> {
  return {
    n: s.name,
    v: s.version ?? "",
    a: s.attributes ? kvsToObject(s.attributes) : {},
  };
}

function kvsToObject(kvs: KeyValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of kvs) out[kv.key] = sanitizeAnyValue(kv.value);
  return out;
}

function sanitizeAnyValue(v: import("./types.js").AnyValue): unknown {
  if (v instanceof Uint8Array) return Array.from(v);
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sanitizeAnyValue);
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = sanitizeAnyValue(val);
    return o;
  }
  return v;
}

function sortedJson(o: unknown): string {
  return JSON.stringify(sortDeep(o));
}

function sortDeep(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(sortDeep);
  if (o !== null && typeof o === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o as Record<string, unknown>).sort()) {
      sorted[k] = sortDeep((o as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return o;
}

function deepEqualResource(a: Resource, b: Resource): boolean {
  return sortedJson(canonResource(a)) === sortedJson(canonResource(b));
}

function deepEqualScope(a: InstrumentationScope, b: InstrumentationScope): boolean {
  return sortedJson(canonScope(a)) === sortedJson(canonScope(b));
}
