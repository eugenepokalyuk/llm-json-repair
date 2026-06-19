import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { repairJson, repairJsonStream } from "../src/index.js";

describe("fuzz / properties", () => {
  it("round-trips any valid JSON unchanged (repaired=false)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const json = JSON.stringify(value);
        const r = repairJson(json);
        expect(r.ok).toBe(true);
        if (r.ok) {
          // `json` is already canonical, so re-serializing must reproduce it.
          expect(JSON.stringify(r.value)).toBe(json);
          expect(r.repaired).toBe(false);
        }
      }),
    );
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => repairJson(s)).not.toThrow();
      }),
    );
  });

  it("always yields JSON-serializable output when it succeeds", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = repairJson(s);
        if (r.ok) expect(() => JSON.stringify(r.value)).not.toThrow();
      }),
    );
  });

  it("survives truncation at any prefix of valid JSON", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.double({ min: 0, max: 1, noNaN: true }), (value, frac) => {
        const json = JSON.stringify(value);
        const cut = json.slice(0, Math.floor(json.length * frac));
        const r = repairJson(cut);
        // Either a clean result or a graceful error — never a throw, and any
        // success must be serializable.
        if (r.ok) expect(() => JSON.stringify(r.value)).not.toThrow();
      }),
    );
  });

  it("streaming chunk-by-chunk never throws and matches a one-shot parse", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.array(fc.integer({ min: 1, max: 8 })), (value, sizes) => {
        const json = JSON.stringify(value);
        const stream = repairJsonStream();
        let pos = 0;
        let idx = 0;
        while (pos < json.length) {
          const size = sizes[idx % sizes.length] ?? 4;
          stream.push(json.slice(pos, pos + size));
          pos += size;
          idx++;
        }
        const final = stream.end();
        expect(final.ok).toBe(true);
        if (final.ok) expect(JSON.stringify(final.value)).toBe(json);
      }),
    );
  });
});
