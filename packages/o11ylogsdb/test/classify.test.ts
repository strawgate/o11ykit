import { describe, it, expect } from "vitest";
import { defaultClassifier, TemplatedClassifier } from "../src/classify.js";
import type { TemplateExtractor } from "../src/classify.js";
import type { LogRecord } from "../src/types.js";

function makeRecord(body: unknown): LogRecord {
  return {
    timeUnixNano: 1000000000n,
    severityNumber: 9,
    severityText: "INFO",
    body: body as LogRecord["body"],
    attributes: [],
  };
}

describe("classifyShape via defaultClassifier", () => {
  it("null → primitive", () => {
    expect(defaultClassifier.classify(makeRecord(null))).toBe("primitive");
  });

  it("string → freetext", () => {
    expect(defaultClassifier.classify(makeRecord("hello world"))).toBe("freetext");
  });

  it("empty string → freetext", () => {
    expect(defaultClassifier.classify(makeRecord(""))).toBe("freetext");
  });

  it("number → primitive", () => {
    expect(defaultClassifier.classify(makeRecord(42))).toBe("primitive");
  });

  it("NaN → primitive", () => {
    expect(defaultClassifier.classify(makeRecord(NaN))).toBe("primitive");
  });

  it("bigint → primitive", () => {
    expect(defaultClassifier.classify(makeRecord(123456789012345678n))).toBe("primitive");
  });

  it("boolean true → primitive", () => {
    expect(defaultClassifier.classify(makeRecord(true))).toBe("primitive");
  });

  it("boolean false → primitive", () => {
    expect(defaultClassifier.classify(makeRecord(false))).toBe("primitive");
  });

  it("Uint8Array → bytes", () => {
    expect(defaultClassifier.classify(makeRecord(new Uint8Array([1, 2, 3])))).toBe("bytes");
  });

  it("empty Uint8Array → bytes", () => {
    expect(defaultClassifier.classify(makeRecord(new Uint8Array(0)))).toBe("bytes");
  });

  it("array → kvlist", () => {
    expect(defaultClassifier.classify(makeRecord([1, 2, 3]))).toBe("kvlist");
  });

  it("empty array → kvlist", () => {
    expect(defaultClassifier.classify(makeRecord([]))).toBe("kvlist");
  });

  it("plain object → kvlist", () => {
    expect(defaultClassifier.classify(makeRecord({ key: "value" }))).toBe("kvlist");
  });

  it("empty object → kvlist", () => {
    expect(defaultClassifier.classify(makeRecord({}))).toBe("kvlist");
  });

  it("undefined → primitive (fallback)", () => {
    expect(defaultClassifier.classify(makeRecord(undefined))).toBe("primitive");
  });
});

describe("TemplatedClassifier", () => {
  function makeExtractor(templates: Map<string, number>): TemplateExtractor {
    return {
      matchTemplate(s: string) {
        const id = templates.get(s);
        if (id === undefined) return undefined;
        return { templateId: id, vars: [] };
      },
      matchOrAdd(s: string) {
        const id = templates.get(s);
        if (id !== undefined) return { templateId: id, vars: [], isNew: false };
        const newId = templates.size;
        templates.set(s, newId);
        return { templateId: newId, vars: [], isNew: true };
      },
      templateCount: () => templates.size,
      templates: function* () {
        for (const [template, id] of templates) yield { id, template };
      },
    };
  }

  it("returns 'templated' when extractor matches string body", () => {
    const ext = makeExtractor(new Map([["Connection from <*>", 0]]));
    const cls = new TemplatedClassifier(ext);
    expect(cls.classify(makeRecord("Connection from <*>"))).toBe("templated");
  });

  it("returns 'freetext' when extractor does NOT match string body", () => {
    const ext = makeExtractor(new Map([["Other template", 0]]));
    const cls = new TemplatedClassifier(ext);
    expect(cls.classify(makeRecord("totally different text"))).toBe("freetext");
  });

  it("returns non-string shapes without consulting extractor", () => {
    let called = false;
    const ext = makeExtractor(new Map());
    const origMatch = ext.matchTemplate.bind(ext);
    ext.matchTemplate = (s: string) => {
      called = true;
      return origMatch(s);
    };
    const cls = new TemplatedClassifier(ext);

    expect(cls.classify(makeRecord(42))).toBe("primitive");
    expect(called).toBe(false);

    expect(cls.classify(makeRecord({ x: 1 }))).toBe("kvlist");
    expect(called).toBe(false);

    expect(cls.classify(makeRecord(new Uint8Array(4)))).toBe("bytes");
    expect(called).toBe(false);
  });

  it("returns 'primitive' for null without consulting extractor", () => {
    const ext = makeExtractor(new Map());
    const cls = new TemplatedClassifier(ext);
    expect(cls.classify(makeRecord(null))).toBe("primitive");
  });
});
