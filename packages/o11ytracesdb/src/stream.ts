/**
 * StreamRegistry — interns (resource, scope) tuples to numeric stream
 * IDs. The chunk pipeline groups spans by stream so each chunk's
 * resource and scope are constants in the header at zero per-row cost.
 *
 * Identical pattern to o11ylogsdb StreamRegistry: FNV-1a hash of
 * canonicalized (resource, scope) JSON, with WeakMap fast path for
 * reference identity.
 */

import type { Chunk } from "./chunk.js";
import type { AnyValue, InstrumentationScope, KeyValue, Resource, StreamId } from "./types.js";

interface StreamEntry {
  id: StreamId;
  resource: Resource;
  scope: InstrumentationScope;
  /** Ordered chunk list, oldest first. */
  chunks: Chunk[];
}

/** Registry that interns (resource, scope) tuples to numeric stream IDs. */
export class StreamRegistry {
  private nextId: StreamId = 1;
  private byHash = new Map<number, StreamEntry[]>();
  private byId = new Map<StreamId, StreamEntry>();
  private byResourceRef: WeakMap<Resource, Map<InstrumentationScope, StreamId>> = new WeakMap();

  /** Resolve or create a stream id for a (resource, scope) pair. */
  intern(resource: Resource, scope: InstrumentationScope): StreamId {
    const refScopeMap = this.byResourceRef.get(resource);
    if (refScopeMap !== undefined) {
      const refId = refScopeMap.get(scope);
      if (refId !== undefined) {
        // Validate the cached id still exists (could be stale after eviction)
        if (this.byId.has(refId)) return refId;
        // Stale entry — remove it
        refScopeMap.delete(scope);
        if (refScopeMap.size === 0) this.byResourceRef.delete(resource);
      }
    }
    const h = hashStream(resource, scope);
    const bucket = this.byHash.get(h) ?? [];
    for (const e of bucket) {
      if (deepEqualResource(e.resource, resource) && deepEqualScope(e.scope, scope)) {
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

  removeChunk(id: StreamId, chunk: Chunk): void {
    const e = this.byId.get(id);
    if (!e) return;
    const idx = e.chunks.indexOf(chunk);
    if (idx !== -1) e.chunks.splice(idx, 1);

    // Clean up empty stream entries to prevent memory leaks
    if (e.chunks.length === 0) {
      this.byId.delete(id);
      const h = hashStream(e.resource, e.scope);
      const bucket = this.byHash.get(h);
      if (bucket) {
        const bucketIdx = bucket.indexOf(e);
        if (bucketIdx !== -1) bucket.splice(bucketIdx, 1);
        if (bucket.length === 0) this.byHash.delete(h);
      }
      // byResourceRef is a WeakMap — entries are GC'd when Resource is no longer referenced
    }
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

function sanitizeAnyValue(v: AnyValue): unknown {
  if (v instanceof Uint8Array) return Array.from(v);
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sanitizeAnyValue);
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = sanitizeAnyValue(val as AnyValue);
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
