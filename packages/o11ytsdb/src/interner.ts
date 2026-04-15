export type InternId = number;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MAX_LOAD = 0.7;

export class Interner {
  private readonly encoder = new ((globalThis as unknown) as { TextEncoder: new () => { encode(input: string): Uint8Array } }).TextEncoder();
  private readonly decoder = new ((globalThis as unknown) as {
    TextDecoder: new () => { decode(input: Uint8Array): string };
  }).TextDecoder();

  private bytes = new Uint8Array(1024);
  private bytesUsed = 0;
  private offsets = new Uint32Array(1024); // offsets[id]..offsets[id+1]
  private count = 0;

  private slots = new Uint32Array(2048); // id + 1; 0 means empty
  private hashes = new Uint32Array(2048);
  private mask = this.slots.length - 1;

  intern(input: string): InternId {
    const encoded = this.encoder.encode(input);
    return this.internBytes(encoded);
  }

  bulkIntern(strings: string[]): Uint32Array {
    const ids = new Uint32Array(strings.length);
    for (let i = 0; i < strings.length; i++) {
      ids[i] = this.intern(strings[i]!);
    }
    return ids;
  }

  resolve(id: InternId): string {
    if (id < 0 || id >= this.count) {
      throw new RangeError(`invalid intern id: ${id}`);
    }
    const start = this.offsets[id]!;
    const end = this.offsets[id + 1]!;
    return this.decoder.decode(this.bytes.subarray(start, end));
  }

  get size(): number {
    return this.count;
  }

  memoryBytes(): number {
    return this.bytes.byteLength + this.offsets.byteLength + this.slots.byteLength + this.hashes.byteLength;
  }

  private internBytes(encoded: Uint8Array): InternId {
    if ((this.count + 1) / this.slots.length > MAX_LOAD) {
      this.resizeTable(this.slots.length * 2);
    }
    const hash = fnv1a(encoded) || 1;
    let slot = hash & this.mask;
    while (true) {
      const existing = this.slots[slot]!;
      if (existing === 0) {
        return this.insert(slot, hash, encoded);
      }
      const id = existing - 1;
      if (this.hashes[slot] === hash && this.equalsBytes(id, encoded)) {
        return id;
      }
      slot = (slot + 1) & this.mask;
    }
  }

  private equalsBytes(id: number, candidate: Uint8Array): boolean {
    const start = this.offsets[id]!;
    const end = this.offsets[id + 1]!;
    if (end - start !== candidate.length) return false;
    for (let i = 0; i < candidate.length; i++) {
      if (this.bytes[start + i] !== candidate[i]) return false;
    }
    return true;
  }

  private insert(slot: number, hash: number, encoded: Uint8Array): InternId {
    this.ensureOffsets(this.count + 2);
    this.ensureBytes(this.bytesUsed + encoded.length);

    const id = this.count;
    this.bytes.set(encoded, this.bytesUsed);
    this.offsets[id] = this.bytesUsed;
    this.bytesUsed += encoded.length;
    this.offsets[id + 1] = this.bytesUsed;
    this.count++;

    this.slots[slot] = id + 1;
    this.hashes[slot] = hash;
    return id;
  }

  private ensureBytes(need: number): void {
    if (need <= this.bytes.length) return;
    let next = this.bytes.length;
    while (next < need) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.bytes.subarray(0, this.bytesUsed));
    this.bytes = grown;
  }

  private ensureOffsets(need: number): void {
    if (need <= this.offsets.length) return;
    let next = this.offsets.length;
    while (next < need) next *= 2;
    const grown = new Uint32Array(next);
    grown.set(this.offsets.subarray(0, this.count + 1));
    this.offsets = grown;
  }

  private resizeTable(newSize: number): void {
    const slots = new Uint32Array(newSize);
    const hashes = new Uint32Array(newSize);
    const mask = newSize - 1;
    for (let i = 0; i < this.slots.length; i++) {
      const entry = this.slots[i]!;
      if (entry === 0) continue;
      const hash = this.hashes[i]!;
      let slot = hash & mask;
      while (slots[slot] !== 0) slot = (slot + 1) & mask;
      slots[slot] = entry;
      hashes[slot] = hash;
    }
    this.slots = slots;
    this.hashes = hashes;
    this.mask = mask;
  }
}

export function fnv1a(input: Uint8Array): number {
  let hash = FNV_OFFSET >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input[i]!;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}
