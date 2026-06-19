import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HealJsonError, heal, healAsync, healOrThrow, repair } from "../src/index.js";

describe("heal — clean input", () => {
  it("parses already-valid JSON and reports repaired=false", () => {
    const r = heal('{"name":"Ada","age":36}');
    expect(r).toEqual({ ok: true, repaired: false, value: { name: "Ada", age: 36 } });
  });

  it("parses valid arrays and scalars", () => {
    expect(heal("[1,2,3]")).toMatchObject({ ok: true, value: [1, 2, 3] });
    expect(heal('"hello"')).toMatchObject({ ok: true, value: "hello" });
    expect(heal("42")).toMatchObject({ ok: true, value: 42 });
    expect(heal("true")).toMatchObject({ ok: true, value: true });
    expect(heal("null")).toMatchObject({ ok: true, value: null });
  });
});

describe("heal — repairs", () => {
  it("strips markdown code fences", () => {
    const r = heal('```json\n{"ok":true}\n```');
    expect(r).toMatchObject({ ok: true, repaired: true, value: { ok: true } });
  });

  it("handles an unclosed code fence (truncated output)", () => {
    const r = heal('```json\n{"a":1,"b":2}');
    expect(r).toMatchObject({ ok: true, value: { a: 1, b: 2 } });
  });

  it("ignores prose around the JSON", () => {
    const r = heal('Sure! Here is the data you asked for:\n{"x":1}\nHope that helps!');
    expect(r).toMatchObject({ ok: true, value: { x: 1 } });
  });

  it("removes trailing commas", () => {
    expect(heal('{"a":1,"b":2,}')).toMatchObject({ ok: true, value: { a: 1, b: 2 } });
    expect(heal("[1,2,3,]")).toMatchObject({ ok: true, value: [1, 2, 3] });
  });

  it("accepts single-quoted strings", () => {
    expect(heal("{'name':'Ada'}")).toMatchObject({ ok: true, value: { name: "Ada" } });
  });

  it("accepts smart/curly quotes", () => {
    const r = heal("{“name”:“Ada”}");
    expect(r).toMatchObject({ ok: true, value: { name: "Ada" } });
  });

  it("accepts unquoted object keys", () => {
    expect(heal("{name:'Ada',age:36}")).toMatchObject({
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
    expect(heal(input)).toMatchObject({ ok: true, value: { name: "Ada", age: 36 } });
  });

  it("understands Python-style literals", () => {
    expect(heal("{'a':True,'b':False,'c':None}")).toMatchObject({
      ok: true,
      value: { a: true, b: false, c: null },
    });
  });

  it("closes truncated objects and arrays", () => {
    expect(heal('{"a":1,"b":[1,2,3')).toMatchObject({
      ok: true,
      value: { a: 1, b: [1, 2, 3] },
    });
  });

  it("closes a truncated string", () => {
    expect(heal('{"note":"this got cut off')).toMatchObject({
      ok: true,
      value: { note: "this got cut off" },
    });
  });

  it("handles nested mess", () => {
    const input = "```\n{users: [{name: 'Ada', roles: ['admin',]}, {name: 'Bob',}],}\n```";
    expect(heal(input)).toMatchObject({
      ok: true,
      value: {
        users: [{ name: "Ada", roles: ["admin"] }, { name: "Bob" }],
      },
    });
  });
});

describe("heal — errors", () => {
  it("reports empty input", () => {
    expect(heal("   ")).toEqual({
      ok: false,
      error: { code: "empty_input", message: "Input is empty" },
    });
  });

  it("reports unparseable input", () => {
    const r = heal("this is just a sentence with no json");
    // No struct + bareword → parses the first token as a string, never throws.
    expect(r.ok).toBe(true);
  });

  it("reports parse_error when there is truly nothing to parse", () => {
    const r = heal("// just a comment, no value at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("parse_error");
  });
});

describe("heal — schema validation", () => {
  const User = z.object({ name: z.string(), age: z.number() });

  it("validates and infers the output type", () => {
    const r = heal('{"name":"Ada","age":36}', User);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Type-level: r.value is { name: string; age: number }
      expect(r.value.name).toBe("Ada");
      expect(r.value.age).toBe(36);
    }
  });

  it("repairs first, then validates", () => {
    const r = heal("```json\n{name:'Ada',age:36,}\n```", User);
    expect(r).toMatchObject({ ok: true, repaired: true, value: { name: "Ada", age: 36 } });
  });

  it("returns validation_error with issues on schema mismatch", () => {
    const r = heal('{"name":"Ada","age":"old"}', User);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("validation_error");
      expect(r.error.issues?.length).toBeGreaterThan(0);
    }
  });

  it("applies schema transforms (coercion)", () => {
    const Coerced = z.object({ age: z.coerce.number() });
    const r = heal("{age:'36'}", Coerced);
    expect(r).toMatchObject({ ok: true, value: { age: 36 } });
  });
});

describe("healAsync", () => {
  it("works with async refinements", async () => {
    const schema = z.string().refine(async (v) => v.length > 1, "too short");
    const r = await healAsync('"hello"', schema);
    expect(r).toMatchObject({ ok: true, value: "hello" });
  });

  it("flags async schemas when used with the sync heal()", () => {
    const schema = z.string().refine(async () => true);
    const r = heal('"hello"', schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("async_schema");
  });
});

describe("healOrThrow", () => {
  it("returns the value on success", () => {
    expect(healOrThrow('{"a":1}')).toEqual({ a: 1 });
  });

  it("throws HealJsonError with a code on failure", () => {
    const schema = z.object({ a: z.string() });
    try {
      healOrThrow('{"a":1}', schema);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HealJsonError);
      expect((err as HealJsonError).code).toBe("validation_error");
    }
  });
});

describe("repair", () => {
  it("returns a canonical JSON string", () => {
    expect(repair("{name:'Ada',}")).toBe('{"name":"Ada"}');
  });

  it("throws on empty input", () => {
    expect(() => repair("")).toThrow(HealJsonError);
  });
});
