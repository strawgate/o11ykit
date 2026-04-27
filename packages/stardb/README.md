# stardb

Shared core (`*db`) for the o11ykit family of in-memory OpenTelemetry
databases. The name is the wildcard match of `o11ytsdb`, `o11ylogsdb`,
and the upcoming `o11ytracesdb`.

This package hosts the abstractions both engines consume — currently the
byte / string / integer codec interfaces and a small set of
baseline implementations.

## Public API

```ts
import {
  CodecRegistry,
  defaultRegistry,
  GzipCodec,
  ZstdCodec,
  rawCodec,
  lengthPrefixStringCodec,
  rawInt64Codec,
  type Codec,
  type StringCodec,
  type IntCodec,
} from "stardb";

const registry = defaultRegistry();
// gzip / zstd / raw / length-prefix / raw-i64-le pre-registered
```

| Symbol | Kind | Purpose |
|---|---|---|
| `Codec` / `CodecRegistry` | interface / class | bytes-in/bytes-out codec + named registry |
| `StringCodec` | interface | per-string codec (random-access optional) |
| `IntCodec` | interface | integer-column codec (timestamps, severities, dict ids) |
| `rawCodec` | const | identity codec |
| `GzipCodec` | class | gzip via `node:zlib`, level 1–9 |
| `ZstdCodec` | class | zstd via `node:zlib`, level 1–22 |
| `lengthPrefixStringCodec` | const | `[u32 LE length][bytes]` per string |
| `rawInt64Codec` | const | raw little-endian i64 per value |
| `defaultRegistry()` | fn | factory pre-populated with all of the above |

## Out of scope

- Engine-specific chunk wire formats (each `*db` carries its own
  metadata in the chunk header).
- `ChunkPolicy` plug-in surfaces (codec choice is engine-specific).
- Record schemas (`LogRecord`, `MetricSample`, `SpanRecord` differ).
- Query languages.

These belong in their respective engine packages. `stardb` is for
the genuinely engine-agnostic primitives.

## Why "stardb"

`*db` — the shell glob for "every `db` package". The shared core
of the family.
