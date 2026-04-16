/**
 * Shared label index — owns string interning, inverted index, and label-pair storage.
 *
 * All storage backends delegate label management here, eliminating
 * the duplicated interner + postings + hash-map + resolve logic
 * that was previously copied across FlatStore, ChunkedStore, and ColumnStore.
 */

import { Interner } from './interner.js';
import { MemPostings } from './postings.js';
import type { Labels, SeriesId } from './types.js';

export class LabelIndex {
  readonly interner: Interner;
  readonly postings: MemPostings;
  private readonly labelHashToIds = new Map<string, SeriesId>();
  private readonly labelPairsById: Uint32Array[] = [];

  constructor(interner?: Interner) {
    this.interner = interner ?? new Interner();
    this.postings = new MemPostings(this.interner);
  }

  /**
   * Resolve labels to a series ID. If the label set is new, assigns `nextId`.
   * Returns the resolved ID and whether a new series was created.
   */
  getOrCreate(labels: Labels, nextId: SeriesId): { id: SeriesId; isNew: boolean } {
    const labelPairs = internLabels(labels, this.interner);
    const key = seriesKeyFromPairs(labelPairs);
    const existing = this.labelHashToIds.get(key);
    if (existing !== undefined) {
      return { id: existing, isNew: false };
    }

    this.labelHashToIds.set(key, nextId);
    this.labelPairsById[nextId] = labelPairs;
    this.postings.add(nextId, labels);
    return { id: nextId, isNew: true };
  }

  /** Return all series IDs where the given label has the given value. */
  matchLabel(label: string, value: string): SeriesId[] {
    return this.postings.get(label, value);
  }

  /** Retrieve the label set for a series. */
  labels(id: SeriesId): Labels | undefined {
    const pairs = this.labelPairsById[id];
    if (!pairs) return undefined;
    const out = new Map<string, string>();
    for (let i = 0; i < pairs.length; i += 2) {
      out.set(this.interner.resolve(pairs[i]!), this.interner.resolve(pairs[i + 1]!));
    }
    return out;
  }

  /** Estimated memory usage in bytes (label pairs + postings + interner). */
  memoryBytes(): number {
    let bytes = 0;
    for (const pairs of this.labelPairsById) {
      if (pairs) bytes += pairs.byteLength;
    }
    bytes += this.postings.memoryBytes();
    return bytes;
  }
}

function internLabels(labels: Labels, interner: Interner): Uint32Array {
  const pairs: Array<[number, number]> = [];
  for (const [k, v] of labels) {
    pairs.push([interner.intern(k), interner.intern(v)]);
  }
  pairs.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const encoded = new Uint32Array(pairs.length * 2);
  for (let i = 0; i < pairs.length; i++) {
    const [k, v] = pairs[i]!;
    encoded[i * 2] = k;
    encoded[i * 2 + 1] = v;
  }
  return encoded;
}

function seriesKeyFromPairs(labelPairs: Uint32Array): string {
  let out = '';
  for (let i = 0; i < labelPairs.length; i += 2) {
    out += `${labelPairs[i]}:${labelPairs[i + 1]},`;
  }
  return out;
}
