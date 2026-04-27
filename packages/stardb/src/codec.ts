/**
 * Codec interfaces + registry — the primary plug-in surface of the
 * engine.
 *
 * `Codec` is the byte-stream interface (encode bytes → bytes, decode
 * bytes → bytes). It covers chunk-level body compression: gzip, zstd,
 * the eventual FSST + per-column composite, etc.
 *
 * `StringCodec` is the per-string interface for the body / attribute
 * value path that needs random-access decode (FSST, OnPair). Bytes-in
 * codecs that scan over the whole stream cannot satisfy `randomAccess`.
 *
 * `IntCodec` is the integer-column interface for ALP / Delta-ALP /
 * FastLanes BP / RLE. It operates on `BigInt64Array` /
 * `Float64Array` row-aligned data.
 *
 * Experiments plug into the registry by name and the chunk pipeline
 * resolves by name. To swap a primary string codec, register a new
 * implementation under the same name (or a new name and update the
 * `ChunkPolicy`).
 */

/** Bytes-in / bytes-out codec for whole-payload compression. */
export interface Codec {
  readonly name: string;
  /** Optional per-codec metadata (window size, level, etc.). */
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
  encode(input: Uint8Array): Uint8Array;
  decode(input: Uint8Array): Uint8Array;
}

/** Per-string codec for variable-width string columns. */
export interface StringCodec {
  readonly name: string;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
  /** Whether per-row decode is supported without scanning a window. */
  readonly randomAccess: boolean;
  encodeBatch(strings: readonly string[]): Uint8Array;
  decodeBatch(input: Uint8Array): string[];
}

/** Integer-column codec (timestamps, severity, dict indices, counts). */
export interface IntCodec {
  readonly name: string;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
  encode(values: BigInt64Array): Uint8Array;
  decode(input: Uint8Array): BigInt64Array;
}

/**
 * Registry of named codecs. Implementations are looked up by name.
 * Multiple registries can coexist in tests.
 */
export class CodecRegistry {
  private readonly bytes = new Map<string, Codec>();
  private readonly strings = new Map<string, StringCodec>();
  private readonly ints = new Map<string, IntCodec>();

  register(c: Codec): this {
    this.bytes.set(c.name, c);
    return this;
  }

  registerString(c: StringCodec): this {
    this.strings.set(c.name, c);
    return this;
  }

  registerInt(c: IntCodec): this {
    this.ints.set(c.name, c);
    return this;
  }

  get(name: string): Codec {
    const c = this.bytes.get(name);
    if (!c) {
      throw new Error(
        `Codec not registered: "${name}". Known: ${[...this.bytes.keys()].join(", ")}`
      );
    }
    return c;
  }

  getString(name: string): StringCodec {
    const c = this.strings.get(name);
    if (!c) {
      throw new Error(
        `String codec not registered: "${name}". Known: ${[...this.strings.keys()].join(", ")}`
      );
    }
    return c;
  }

  getInt(name: string): IntCodec {
    const c = this.ints.get(name);
    if (!c) {
      throw new Error(
        `Int codec not registered: "${name}". Known: ${[...this.ints.keys()].join(", ")}`
      );
    }
    return c;
  }

  has(name: string): boolean {
    return this.bytes.has(name) || this.strings.has(name) || this.ints.has(name);
  }

  list(): { bytes: string[]; strings: string[]; ints: string[] } {
    return {
      bytes: [...this.bytes.keys()],
      strings: [...this.strings.keys()],
      ints: [...this.ints.keys()],
    };
  }
}
