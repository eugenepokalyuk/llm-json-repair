import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  JsonRepairError,
  repairJson,
  repairJsonAsync,
  repairJsonFromStream,
  repairJsonOrThrow,
  repairJsonStream,
  repairToString,
} from "../src/index.js";

describe("repairJson — clean input", () => {
  it("parses already-valid JSON and reports repaired=false", () => {
    const r = repairJson('{"name":"Ada","age":36}');
    expect(r).toEqual({
      ok: true,
      repaired: false,
      repairs: [],
      value: { name: "Ada", age: 36 },
    });
  });

  it("parses valid arrays and scalars", () => {
    expect(repairJson("[1,2,3]")).toMatchObject({ ok: true, value: [1, 2, 3] });
    expect(repairJson('"hello"')).toMatchObject({ ok: true, value: "hello" });
    expect(repairJson("42")).toMatchObject({ ok: true, value: 42 });
    expect(repairJson("true")).toMatchObject({ ok: true, value: true });
    expect(repairJson("null")).toMatchObject({ ok: true, value: null });
  });
});

describe("repairJson — repairs", () => {
  it("strips markdown code fences", () => {
    const r = repairJson('```json\n{"ok":true}\n```');
    expect(r).toMatchObject({ ok: true, repaired: true, value: { ok: true } });
  });

  it("handles an unclosed code fence (truncated output)", () => {
    const r = repairJson('```json\n{"a":1,"b":2}');
    expect(r).toMatchObject({ ok: true, value: { a: 1, b: 2 } });
  });

  it("ignores prose around the JSON", () => {
    const r = repairJson('Sure! Here is the data you asked for:\n{"x":1}\nHope that helps!');
    expect(r).toMatchObject({ ok: true, value: { x: 1 } });
  });

  it("removes trailing commas", () => {
    expect(repairJson('{"a":1,"b":2,}')).toMatchObject({ ok: true, value: { a: 1, b: 2 } });
    expect(repairJson("[1,2,3,]")).toMatchObject({ ok: true, value: [1, 2, 3] });
  });

  it("accepts single-quoted strings", () => {
    expect(repairJson("{'name':'Ada'}")).toMatchObject({ ok: true, value: { name: "Ada" } });
  });

  it("accepts smart/curly quotes", () => {
    const r = repairJson("{“name”:“Ada”}");
    expect(r).toMatchObject({ ok: true, value: { name: "Ada" } });
  });

  it("accepts unquoted object keys", () => {
    expect(repairJson("{name:'Ada',age:36}")).toMatchObject({
      ok: true,
      value: { name: "Ada", age: 36 },
    });
  });

  it("strips // and /* */ comments", () => {
    const input = `{
      // the user's name
      "name": "Ada",
      "age": 36 /* years */
    }`;
    expect(repairJson(input)).toMatchObject({ ok: true, value: { name: "Ada", age: 36 } });
  });

  it("understands Python-style literals", () => {
    expect(repairJson("{'a':True,'b':False,'c':None}")).toMatchObject({
      ok: true,
      value: { a: true, b: false, c: null },
    });
  });

  it("closes truncated objects and arrays", () => {
    expect(repairJson('{"a":1,"b":[1,2,3')).toMatchObject({
      ok: true,
      value: { a: 1, b: [1, 2, 3] },
    });
  });

  it("closes a truncated string", () => {
    expect(repairJson('{"note":"this got cut off')).toMatchObject({
      ok: true,
      value: { note: "this got cut off" },
    });
  });

  it("parses real JSON numbers but does not coerce hex/octal/leading-zero forms", () => {
    expect(repairJson("{a:42,b:-3.14,c:1e3,d:0}")).toMatchObject({
      ok: true,
      value: { a: 42, b: -3.14, c: 1e3, d: 0 },
    });
    // 0x1F / 007 are not valid JSON numbers — keep them verbatim as strings
    // instead of silently producing 31 / 7.
    expect(repairJson("{hex:0x1F,octalish:007}")).toMatchObject({
      ok: true,
      value: { hex: "0x1F", octalish: "007" },
    });
  });

  it("keeps a __proto__ key as own data without polluting the prototype", () => {
    const r = repairJson('{ "__proto__": { "polluted": true }, "safe": 1 }');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const value = r.value as Record<string, unknown>;
      // The key is preserved as own data (matching JSON.parse)…
      expect(Object.hasOwn(value, "__proto__")).toBe(true);
      expect(value.safe).toBe(1);
      // …and nothing leaks onto Object.prototype.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it("handles nested mess", () => {
    const input = "```\n{users: [{name: 'Ada', roles: ['admin',]}, {name: 'Bob',}],}\n```";
    expect(repairJson(input)).toMatchObject({
      ok: true,
      value: {
        users: [{ name: "Ada", roles: ["admin"] }, { name: "Bob" }],
      },
    });
  });
});

describe("repairJson — repair events", () => {
  const kinds = (r: ReturnType<typeof repairJson>) => (r.ok ? r.repairs.map((e) => e.kind) : []);

  it("reports an empty list for already-valid JSON", () => {
    const r = repairJson('{"a":1}');
    expect(r).toMatchObject({ ok: true, repaired: false, repairs: [] });
  });

  it("reports a code_fence repair", () => {
    expect(kinds(repairJson('```json\n{"a":1}\n```'))).toContain("code_fence");
  });

  it("reports trailing/leading commas and unquoted keys", () => {
    const k = kinds(repairJson("{a:1,,b:2,}"));
    expect(k).toContain("unquoted_key");
    expect(k).toContain("leading_comma");
    expect(k).toContain("trailing_comma");
  });

  it("reports non-standard quotes", () => {
    expect(kinds(repairJson("{'a':'b'}"))).toContain("non_standard_quotes");
  });

  it("reports truncation repairs with closed_string / closed_object", () => {
    const k = kinds(repairJson('{"note":"cut off'));
    expect(k).toContain("closed_string");
    expect(k).toContain("closed_object");
  });

  it("reports surrounding prose being dropped", () => {
    expect(kinds(repairJson('Here you go: {"a":1}'))).toContain("surrounding_prose");
  });

  it("carries an index for each repair", () => {
    const r = repairJson('{"note":"cut off');
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const e of r.repairs) expect(typeof e.index).toBe("number");
    }
  });
});

describe("repairJson — depth", () => {
  it("parses reasonably deep nesting without issue", () => {
    const depth = 100;
    const input = "[".repeat(depth) + "]".repeat(depth);
    const r = repairJson(input);
    expect(r.ok).toBe(true);
  });

  it("rejects pathologically deep input as parse_error instead of crashing", () => {
    const input = "[".repeat(100_000);
    const r = repairJson(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("parse_error");
  });
});

describe("repairJson — errors", () => {
  it("reports empty input", () => {
    expect(repairJson("   ")).toEqual({
      ok: false,
      error: { code: "empty_input", message: "Input is empty" },
    });
  });

  it("reports unparseable input", () => {
    const r = repairJson("this is just a sentence with no json");
    // No struct + bareword → parses the first token as a string, never throws.
    expect(r.ok).toBe(true);
  });

  it("reports parse_error when there is truly nothing to parse", () => {
    const r = repairJson("// just a comment, no value at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("parse_error");
  });
});

describe("repairJson — schema validation", () => {
  const User = z.object({ name: z.string(), age: z.number() });

  it("validates and infers the output type", () => {
    const r = repairJson('{"name":"Ada","age":36}', User);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Type-level: r.value is { name: string; age: number }
      expect(r.value.name).toBe("Ada");
      expect(r.value.age).toBe(36);
    }
  });

  it("repairs first, then validates", () => {
    const r = repairJson("```json\n{name:'Ada',age:36,}\n```", User);
    expect(r).toMatchObject({ ok: true, repaired: true, value: { name: "Ada", age: 36 } });
  });

  it("returns validation_error with issues on schema mismatch", () => {
    const r = repairJson('{"name":"Ada","age":"old"}', User);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("validation_error");
      expect(r.error.issues?.length).toBeGreaterThan(0);
    }
  });

  it("applies schema transforms (coercion)", () => {
    const Coerced = z.object({ age: z.coerce.number() });
    const r = repairJson("{age:'36'}", Coerced);
    expect(r).toMatchObject({ ok: true, value: { age: 36 } });
  });
});

describe("repairJson — options", () => {
  it("accepts options as the second argument (no schema)", () => {
    // Unclosed brackets force the tolerant (repair) path, where maxDepth lives.
    const input = "[".repeat(50);
    const tooDeep = repairJson(input, { maxDepth: 10 });
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) expect(tooDeep.error.code).toBe("parse_error");

    const okDepth = repairJson(input, { maxDepth: 100 });
    expect(okDepth.ok).toBe(true);
  });

  it("accepts options as the third argument alongside a schema", () => {
    const User = z.object({ name: z.string() });
    const r = repairJson('{name:"Ada",}', User, { maxDepth: 100 });
    expect(r).toMatchObject({ ok: true, value: { name: "Ada" } });
  });

  it("parses precision-losing integers as bigint when asked", () => {
    const r = repairJson('{"id": 12345678901234567890}', { bigint: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const value = r.value as { id: bigint };
      expect(typeof value.id).toBe("bigint");
      expect(value.id).toBe(12345678901234567890n);
    }
  });

  it("leaves safe integers as plain numbers even with bigint enabled", () => {
    const r = repairJson('{"n": 42}', { bigint: true });
    expect(r).toMatchObject({ ok: true, value: { n: 42 } });
    if (r.ok) expect(typeof (r.value as { n: unknown }).n).toBe("number");
  });
});

describe("repairJsonStream", () => {
  const User = z.object({ name: z.string(), age: z.number() });

  it("yields a best-effort value as chunks arrive and validates on end()", () => {
    const stream = repairJsonStream(User);
    const chunks = ['{"name": "Ad', 'a", "ag', 'e": 3', "6}"];

    const partials = chunks.map((c) => stream.push(c));
    // Every partial should be a parseable (best-effort) object…
    for (const p of partials) expect(p.ok).toBe(true);
    // …and the buffer reflects everything seen.
    expect(stream.buffer).toBe('{"name": "Ada", "age": 36}');

    const final = stream.end();
    expect(final).toMatchObject({ ok: true, value: { name: "Ada", age: 36 } });
  });

  it("exposes the partial object mid-stream", () => {
    const stream = repairJsonStream();
    const r = stream.push('{"items": [1, 2');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ items: [1, 2] });
  });

  it("works without a schema", () => {
    const stream = repairJsonStream();
    stream.push('{"a":1');
    expect(stream.end()).toMatchObject({ ok: true, value: { a: 1 } });
  });

  it("repairJsonFromStream drains an async iterable and reports partials", async () => {
    async function* gen() {
      yield '{"name": "Ada"';
      yield ', "age": 36}';
    }
    const seen: number[] = [];
    const final = await repairJsonFromStream(gen(), User, {
      onPartial: (p) => {
        if (p.ok) seen.push(1);
      },
    });
    expect(final).toMatchObject({ ok: true, value: { name: "Ada", age: 36 } });
    expect(seen.length).toBe(2);
  });
});

describe("repairJsonAsync", () => {
  it("works with async refinements", async () => {
    const schema = z.string().refine(async (v) => v.length > 1, "too short");
    const r = await repairJsonAsync('"hello"', schema);
    expect(r).toMatchObject({ ok: true, value: "hello" });
  });

  it("flags async schemas when used with the sync repairJson()", () => {
    const schema = z.string().refine(async () => true);
    const r = repairJson('"hello"', schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("async_schema");
  });
});

describe("repairJsonOrThrow", () => {
  it("returns the value on success", () => {
    expect(repairJsonOrThrow('{"a":1}')).toEqual({ a: 1 });
  });

  it("throws JsonRepairError with a code on failure", () => {
    const schema = z.object({ a: z.string() });
    try {
      repairJsonOrThrow('{"a":1}', schema);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JsonRepairError);
      expect((err as JsonRepairError).code).toBe("validation_error");
    }
  });
});

describe("repairToString", () => {
  it("returns a canonical JSON string", () => {
    expect(repairToString("{name:'Ada',}")).toBe('{"name":"Ada"}');
  });

  it("throws on empty input", () => {
    expect(() => repairToString("")).toThrow(JsonRepairError);
  });
});
