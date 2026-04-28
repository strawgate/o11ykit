import { defaultRegistry } from "stardb";
import { describe, expect, it } from "vitest";

import { ChunkBuilder, readBodiesOnly, readRecords } from "../src/chunk.js";
import { TypedColumnarDrainPolicy } from "../src/codec-typed.js";
import type { InstrumentationScope, LogRecord, Resource } from "../src/types.js";

const resource: Resource = { attributes: [{ key: "service.name", value: "test" }] };
const scope: InstrumentationScope = { name: "test-scope" };
const registry = defaultRegistry();

function freezeWith(policy: TypedColumnarDrainPolicy, records: readonly LogRecord[]) {
  const builder = new ChunkBuilder(resource, scope, policy, registry);
  for (const r of records) builder.append(r);
  return builder.freeze();
}

function makeRecord(i: number, body: string, severity = 9): LogRecord {
  return {
    timeUnixNano: BigInt(1_000_000_000 + i * 1000),
    severityNumber: severity,
    severityText: severity >= 13 ? "WARN" : "INFO",
    body,
    attributes: [],
  };
}

describe("TypedColumnarDrainPolicy: special characters", () => {
  it("round-trips bodies with newlines and tabs (Drain normalizes whitespace)", () => {
    const policy = new TypedColumnarDrainPolicy();
    // Drain normalizes multi-space/newline/tab to single space
    // So bodies with whitespace variations get normalized
    const records: LogRecord[] = [
      makeRecord(0, "line1\nline2\nline3"),
      makeRecord(1, "col1\tcol2\tcol3"),
      makeRecord(2, "mixed\n\ttab\n\ttab"),
      makeRecord(3, "trailing newline\n"),
    ];
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    expect(decoded.length).toBe(4);
    // Drain normalizes whitespace: newlines/tabs → single space
    expect(decoded[0]?.body).toBe("line1 line2 line3");
    expect(decoded[1]?.body).toBe("col1 col2 col3");
    expect(decoded[2]?.body).toBe("mixed tab tab");
    expect(decoded[3]?.body).toBe("trailing newline");
  });

  it("round-trips bodies with unicode and emoji", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [
      makeRecord(0, "résumé café naïve"),
      makeRecord(1, "日本語テスト"),
      makeRecord(2, "emoji 🚀🎉✨ test"),
      makeRecord(3, "Ñoño señor"),
    ];
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });

  it("round-trips bodies with template-like patterns that Drain might misclassify", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    // These look like they could be templates but each is unique
    for (let i = 0; i < 10; i++) {
      records.push(makeRecord(i, `user_${i * 31} action_${i * 17} result_${i * 13}`));
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });
});

describe("TypedColumnarDrainPolicy: UUID slot values", () => {
  it("round-trips canonical UUID values exactly", () => {
    const policy = new TypedColumnarDrainPolicy();
    const uuids = [
      "550e8400-e29b-41d4-a716-446655440000",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ];
    const records: LogRecord[] = [];
    for (let i = 0; i < 80; i++) {
      records.push(makeRecord(i, `processing request ${uuids[i % uuids.length]} now`));
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });
});

describe("TypedColumnarDrainPolicy: SIGNED_INT slots", () => {
  it("round-trips negative numbers, zero, and large values", () => {
    const policy = new TypedColumnarDrainPolicy();
    const values = [-999999, -1, 0, 1, 42, 1000000, 9007199254740991];
    const records: LogRecord[] = [];
    for (let i = 0; i < 80; i++) {
      records.push(makeRecord(i, `counter value is ${values[i % values.length]} units`));
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });
});

describe("TypedColumnarDrainPolicy: PREFIXED_INT64 slots", () => {
  it("round-trips prefixed integer values", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 80; i++) {
      records.push(makeRecord(i, `block blk_${1_000_000 + i * 7} replicated to storage`));
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });

  it("round-trips negative prefixed values", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 80; i++) {
      records.push(makeRecord(i, `offset idx_${-(i * 3 + 1)} calculated`));
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });
});

describe("TypedColumnarDrainPolicy: TIMESTAMP_DELTA slots", () => {
  it("round-trips ISO 8601 microsecond timestamps", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 80; i++) {
      const us = (675872 + i * 100).toString().padStart(6, "0");
      records.push(makeRecord(i, `event at 2005-06-03T15:42:50.${us}Z completed`));
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });

  it("round-trips BGL-style timestamps", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 80; i++) {
      const us = (100000 + i * 50).toString().padStart(6, "0");
      records.push(makeRecord(i, `log at 2005-06-03-15.42.50.${us} processed`));
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });
});

describe("TypedColumnarDrainPolicy: structured (KVList/map) bodies", () => {
  it("round-trips map bodies through sidecar", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push({
        timeUnixNano: BigInt(i),
        severityNumber: 9,
        severityText: "INFO",
        body: { method: "GET", path: `/api/v${i}`, status: 200 + i },
        attributes: [],
      });
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toEqual(records[i]?.body);
    }
  });
});

describe("TypedColumnarDrainPolicy: readBodiesOnly correctness", () => {
  it("readBodiesOnly returns same bodies as readRecords", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 60; i++) {
      records.push(makeRecord(i, `user user_${i % 5} completed request ${i}`));
    }
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodiesOnly = readBodiesOnly(chunk, registry, policy);
    expect(bodiesOnly.length).toBe(fullRecords.length);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodiesOnly[i]).toEqual(fullRecords[i]?.body);
    }
  });

  it("readBodiesOnly handles mixed chunk (templated + raw + structured)", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    // Templated bodies (repeated structure)
    for (let i = 0; i < 20; i++) {
      records.push(makeRecord(i, `request ${i} processed in queue`));
    }
    // Raw string body (unique)
    records.push(makeRecord(20, "this is a completely unique one-off log message xyz123"));
    // Structured body
    records.push({
      timeUnixNano: BigInt(21),
      severityNumber: 9,
      severityText: "INFO",
      body: { event: "click", target: "button" },
      attributes: [],
    });
    const chunk = freezeWith(policy, records);
    const fullRecords = readRecords(chunk, registry, policy);
    const bodiesOnly = readBodiesOnly(chunk, registry, policy);
    expect(bodiesOnly.length).toBe(fullRecords.length);
    for (let i = 0; i < fullRecords.length; i++) {
      expect(bodiesOnly[i]).toEqual(fullRecords[i]?.body);
    }
  });
});

describe("TypedColumnarDrainPolicy: toks in codecMeta", () => {
  it("chunk header contains toks when templates are present", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    for (let i = 0; i < 60; i++) {
      records.push(makeRecord(i, `user user_${i % 5} logged in from host_${i % 3}`));
    }
    const chunk = freezeWith(policy, records);
    const meta = chunk.header.codecMeta as { toks?: string[] };
    expect(meta.toks).toBeDefined();
    expect(Array.isArray(meta.toks)).toBe(true);
    // Should contain literal tokens from the template (not wildcards)
    expect(meta.toks!.length).toBeGreaterThan(0);
    // "user", "logged", "in", "from" should appear as literal tokens
    const toks = meta.toks!;
    expect(toks.some((t) => t === "user" || t === "logged" || t === "in" || t === "from")).toBe(
      true
    );
  });

  it("chunk header has no toks when all bodies are structured (non-string)", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    // Structured/map bodies are never templated by Drain
    for (let i = 0; i < 5; i++) {
      records.push({
        timeUnixNano: BigInt(i),
        severityNumber: 9,
        severityText: "INFO",
        body: { key: `val_${i}`, num: i },
        attributes: [],
      });
    }
    const chunk = freezeWith(policy, records);
    const meta = chunk.header.codecMeta as { toks?: string[] };
    // No string bodies → no templates → no toks
    expect(!meta.toks || meta.toks.length === 0).toBe(true);
  });
});

describe("TypedColumnarDrainPolicy: edge-case chunk shapes", () => {
  it("single-record chunk round-trips", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [makeRecord(0, "single record body")];
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    expect(decoded.length).toBe(1);
    expect(decoded[0]?.body).toBe("single record body");
  });

  it("all-raw-string chunk (no templates) round-trips", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    // Each body is completely different — no template can form
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    for (let i = 0; i < 8; i++) {
      records.push(makeRecord(i, `${words[i]} standalone unique body ${i * 31}`));
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });

  it("all-templated chunk (100% template match) round-trips", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    // Identical structure — all will match the same template
    for (let i = 0; i < 60; i++) {
      records.push(makeRecord(i, `request ${i} completed in ${i * 10}ms`));
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });

  it("mixed chunk (some templated, some raw, some structured) round-trips", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    // Templated (repeated structure)
    for (let i = 0; i < 20; i++) {
      records.push(makeRecord(i, `connection from host_${i % 4} established`));
    }
    // Raw strings (unique)
    records.push(makeRecord(20, "a completely unrepeated message about elephants and rockets"));
    records.push(makeRecord(21, "another unique log regarding submarines and caterpillars"));
    // Structured
    records.push({
      timeUnixNano: 22n,
      severityNumber: 13,
      severityText: "WARN",
      body: { alert: "high CPU", pct: 95.2 },
      attributes: [],
    });
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    expect(decoded.length).toBe(records.length);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toEqual(records[i]?.body);
    }
  });

  it("chunk with many different templates (10+ clusters) round-trips", () => {
    const policy = new TypedColumnarDrainPolicy();
    const records: LogRecord[] = [];
    // 12 different template shapes, each repeated enough for Drain to stabilize
    const templates = [
      (i: number) => `auth user_${i} login from ip_${i}`,
      (i: number) => `db query took ${i}ms on table_${i}`,
      (i: number) => `cache hit for key_${i} in region_${i}`,
      (i: number) => `http GET /api/v${i} returned ${200 + (i % 5)}`,
      (i: number) => `file upload ${i}bytes to bucket_${i}`,
      (i: number) => `email sent to user_${i} with template_${i}`,
      (i: number) => `payment processed amount_${i} currency_${i}`,
      (i: number) => `notification pushed to device_${i} channel_${i}`,
      (i: number) => `search query ${i} returned ${i * 10} results`,
      (i: number) => `worker ${i} picked up job_${i}`,
      (i: number) => `metric reported cpu_${i} memory_${i}`,
      (i: number) => `config reloaded version_${i} source_${i}`,
    ];
    for (let i = 0; i < 120; i++) {
      const tpl = templates[i % 12] as (i: number) => string;
      records.push(makeRecord(i, tpl(i)));
    }
    const chunk = freezeWith(policy, records);
    const decoded = readRecords(chunk, registry, policy);
    expect(decoded.length).toBe(records.length);
    for (let i = 0; i < records.length; i++) {
      expect(decoded[i]?.body).toBe(records[i]?.body);
    }
  });
});
