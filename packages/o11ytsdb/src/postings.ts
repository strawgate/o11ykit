import type { Labels, SeriesId } from './types.js';
import { Interner } from './interner.js';

export class MemPostings {
  private readonly byLabel = new Map<number, Map<number, SeriesId[]>>();
  private readonly interner: Interner;

  constructor(interner?: Interner) {
    this.interner = interner ?? new Interner();
  }

  add(seriesId: SeriesId, labels: Labels): void {
    for (const [label, value] of labels) {
      const labelId = this.interner.intern(label);
      const valueId = this.interner.intern(value);
      let values = this.byLabel.get(labelId);
      if (!values) {
        values = new Map();
        this.byLabel.set(labelId, values);
      }
      let posting = values.get(valueId);
      if (!posting) {
        posting = [];
        values.set(valueId, posting);
      }
      const last = posting[posting.length - 1];
      if (last !== seriesId) posting.push(seriesId);
    }
  }

  get(label: string, value: string): SeriesId[] {
    const labelId = this.interner.intern(label);
    const valueId = this.interner.intern(value);
    return this.byLabel.get(labelId)?.get(valueId)?.slice() ?? [];
  }

  intersect(a: SeriesId[], b: SeriesId[]): SeriesId[] {
    if (a.length === 0 || b.length === 0) return [];
    const small = a.length <= b.length ? a : b;
    const big = a.length <= b.length ? b : a;
    const out: SeriesId[] = [];
    let j = 0;
    for (let i = 0; i < small.length; i++) {
      const v = small[i]!;
      j = gallopLowerBound(big, v, j);
      if (j >= big.length) break;
      if (big[j] === v) out.push(v);
    }
    return out;
  }

  union(a: SeriesId[], b: SeriesId[]): SeriesId[] {
    const out: SeriesId[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const av = a[i]!;
      const bv = b[j]!;
      if (av === bv) {
        out.push(av);
        i++;
        j++;
      } else if (av < bv) {
        out.push(av);
        i++;
      } else {
        out.push(bv);
        j++;
      }
    }
    while (i < a.length) out.push(a[i++]!);
    while (j < b.length) out.push(b[j++]!);
    return out;
  }

  matchRegex(label: string, pattern: RegExp): SeriesId[] {
    const labelId = this.interner.intern(label);
    const values = this.byLabel.get(labelId);
    if (!values) return [];
    let acc: SeriesId[] = [];
    for (const [valueId, posting] of values) {
      if (!pattern.test(this.interner.resolve(valueId))) continue;
      acc = acc.length === 0 ? posting.slice() : this.union(acc, posting);
    }
    return acc;
  }

  memoryBytes(): number {
    let postingsBytes = 0;
    for (const [, values] of this.byLabel) {
      for (const [, posting] of values) postingsBytes += posting.length * 4;
    }
    return postingsBytes + this.interner.memoryBytes();
  }
}

function gallopLowerBound(arr: number[], target: number, from: number): number {
  if (from >= arr.length) return arr.length;
  if (arr[from]! >= target) return from;
  let step = 1;
  let lo = from + 1;
  let hi = lo;
  while (hi < arr.length && arr[hi]! < target) {
    lo = hi + 1;
    step <<= 1;
    hi = from + step;
  }
  if (hi >= arr.length) hi = arr.length - 1;
  let left = lo;
  let right = hi;
  while (left <= right) {
    const mid = (left + right) >>> 1;
    if (arr[mid]! < target) left = mid + 1;
    else right = mid - 1;
  }
  return left;
}
