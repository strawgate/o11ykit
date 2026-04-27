# stardb

Shared core (`*db`) for the o11ykit family of in-memory OpenTelemetry
databases. The name is the wildcard match of `o11ytsdb`, `o11ylogsdb`,
and the upcoming `o11ytracesdb`.

This package hosts the abstractions every engine consumes:

- **Codec layer** — byte / string / integer codec interfaces, a named
  registry, and baseline implementations (gzip / zstd / raw /
  length-prefix / raw-i64-le).
- **OTLP primitives** — `AnyValue`, `KeyValue`, `Resource`,
  `InstrumentationScope`, `SeverityText`, `StreamId`. The shared
  ingest vocabulary every `*db` engine speaks.

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
  type AnyValue,
  type KeyValue,
  type Resource,
  type InstrumentationScope,
  type SeverityText,
  type StreamId,
} from "stardb";

const registry = defaultRegistry();
// gzip / zstd / raw / length-prefix / raw-i64-le pre-registered
```

### Codec layer

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

### OTLP primitives

| Type | OTLP source | Notes |
|---|---|---|
| `SeverityText` | `severity_text` | `TRACE` / `DEBUG` / `INFO` / `WARN` / `ERROR` / `FATAL` |
| `AnyValue` | `AnyValue` | recursive primitive / list / map (incl. `bigint`, `Uint8Array`) |
| `KeyValue` | `KeyValue` | attribute key + `AnyValue` |
| `Resource` | `Resource` | `attributes` + optional dropped count |
| `InstrumentationScope` | `InstrumentationScope` | `name` / optional `version` / attributes |
| `StreamId` | n/a (engine-local) | hash-derived integer; namespace local to each engine instance |

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
