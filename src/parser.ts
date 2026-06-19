/**
 * A tolerant JSON parser that turns the messy "almost-JSON" that LLMs and other
 * loose sources produce into a real JavaScript value.
 *
 * It handles, among other things:
 *  - Markdown code fences (```json … ```), incl. unclosed fences
 *  - Leading/trailing prose around the JSON ("Sure! Here you go: { … }")
 *  - Single quotes, smart/curly quotes, and unquoted object keys
 *  - Trailing and leading commas
 *  - `//` and `/* … *\/` comments
 *  - Python-style literals: `True`, `False`, `None`
 *  - Truncated output (unterminated strings / unclosed brackets get closed)
 */

import type { RepairEvent, RepairKind } from "./types.js";

const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”", // “ ”
  "‘": "’", // ‘ ’
};

const ESCAPE_CHARS: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
  '"': '"',
  "'": "'",
  "\\": "\\",
  "/": "/",
  "`": "`",
};

const WHITESPACE = new Set([" ", "\n", "\t", "\r", "\f", "\v", "﻿", " "]);

function isOpenQuote(c: string | undefined): c is string {
  return c !== undefined && c in QUOTE_PAIRS;
}

/**
 * Assign `key` on `obj` as an own property, matching `JSON.parse` semantics.
 *
 * A plain `obj["__proto__"] = value` would mutate the object's prototype
 * instead of creating an own `__proto__` key, silently dropping the data (and
 * opening a prototype-pollution hole). `Object.defineProperty` sidesteps both.
 */
function assignKey(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

/**
 * Strict JSON number grammar. Deliberately *narrower* than `Number()`, which
 * happily coerces `0x1F` → 31, `007` → 7 and `0b10` → 2. Anything outside this
 * grammar is kept as a verbatim string rather than silently turned into a
 * different value.
 */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** An integer literal that `Number` cannot represent without losing precision. */
function isUnsafeInteger(raw: string): boolean {
  if (raw.includes(".") || raw.includes("e") || raw.includes("E")) return false;
  return !Number.isSafeInteger(Number(raw));
}

function interpretLiteral(raw: string, bigint: boolean): unknown {
  if (raw === "") return null;
  switch (raw) {
    case "true":
    case "True":
    case "TRUE":
      return true;
    case "false":
    case "False":
    case "FALSE":
      return false;
    case "null":
    case "Null":
    case "NULL":
    case "None":
    case "nil":
    case "undefined":
    case "NaN":
    case "nan":
    case "Infinity":
    case "-Infinity":
    case "infinity":
      return null;
  }
  if (JSON_NUMBER.test(raw)) {
    if (bigint && isUnsafeInteger(raw)) return BigInt(raw);
    return Number(raw);
  }
  // Unrecognized bareword (incl. hex/octal/leading-zero forms): keep the
  // literal text rather than coercing it to a surprising number.
  return raw;
}

/**
 * Default nesting limit. The parser is recursive-descent, so without a bound a
 * pathologically nested input (e.g. `[[[[…` thousands deep) overflows the call
 * stack with an opaque `RangeError`. 512 is far beyond any realistic LLM
 * payload while staying well clear of the stack ceiling.
 */
export const DEFAULT_MAX_DEPTH = 512;

/** Thrown when input nests deeper than the configured `maxDepth`. */
export class MaxDepthError extends SyntaxError {
  constructor(maxDepth: number) {
    super(`Maximum nesting depth of ${maxDepth} exceeded`);
    this.name = "MaxDepthError";
  }
}

class TolerantParser {
  private i = 0;
  private depth = 0;
  private readonly s: string;
  private readonly len: number;
  private readonly maxDepth: number;
  private readonly bigint: boolean;
  readonly repairs: RepairEvent[] = [];

  constructor(source: string, options: ParseOptions = {}) {
    this.s = source;
    this.len = source.length;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.bigint = options.bigint ?? false;
  }

  private add(kind: RepairKind, index = this.i): void {
    this.repairs.push({ kind, index });
  }

  private enter(): void {
    if (++this.depth > this.maxDepth) {
      throw new MaxDepthError(this.maxDepth);
    }
  }

  parse(): unknown {
    const start = this.findStructStart();
    if (start > 0) {
      this.add("surrounding_prose", 0);
      this.i = start;
    } else if (start < 0) {
      this.skipWs();
    }
    if (this.i >= this.len) {
      throw new SyntaxError("No JSON value found in input");
    }
    return this.parseValue();
  }

  /** Index of the first `{` or `[` (the usual start of LLM structured output). */
  private findStructStart(): number {
    for (let j = 0; j < this.len; j++) {
      const c = this.s[j];
      if (c === "{" || c === "[") return j;
    }
    return -1;
  }

  private skipWs(): void {
    while (this.i < this.len) {
      const c = this.s[this.i];
      if (WHITESPACE.has(c)) {
        this.i++;
      } else if (c === "/" && this.s[this.i + 1] === "/") {
        this.add("comment");
        this.i += 2;
        while (this.i < this.len && this.s[this.i] !== "\n") this.i++;
      } else if (c === "/" && this.s[this.i + 1] === "*") {
        this.add("comment");
        this.i += 2;
        while (this.i < this.len && !(this.s[this.i] === "*" && this.s[this.i + 1] === "/")) {
          this.i++;
        }
        this.i += 2;
      } else {
        break;
      }
    }
  }

  private parseValue(): unknown {
    this.skipWs();
    if (this.i >= this.len) return null; // truncated
    const c = this.s[this.i];
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (isOpenQuote(c)) return this.parseString();
    return this.parseLiteral();
  }

  private parseObject(): Record<string, unknown> {
    this.enter();
    try {
      return this.parseObjectBody();
    } finally {
      this.depth--;
    }
  }

  private parseObjectBody(): Record<string, unknown> {
    const openIndex = this.i;
    this.i++; // consume "{"
    const obj: Record<string, unknown> = {};
    let closed = false;
    while (this.i < this.len) {
      this.skipWs();
      const c = this.s[this.i];
      if (c === undefined) break; // truncated
      if (c === "}") {
        this.i++;
        closed = true;
        break;
      }
      if (c === ",") {
        // stray / leading comma
        this.add("leading_comma");
        this.i++;
        continue;
      }
      const before = this.i;

      let key: string;
      if (isOpenQuote(c)) {
        key = this.parseString();
      } else {
        this.add("unquoted_key");
        key = this.parseUnquotedKey();
      }

      this.skipWs();
      if (this.s[this.i] === ":") this.i++;
      this.skipWs();

      if (this.i >= this.len) {
        // truncated right after the key
        assignKey(obj, key, null);
        break;
      }

      assignKey(obj, key, this.parseValue());
      this.skipWs();

      const sep = this.s[this.i];
      if (sep === ",") {
        this.i++;
        if (this.peekNonWs() === "}") this.add("trailing_comma");
        continue;
      }
      if (sep === "}") {
        this.i++;
        closed = true;
        break;
      }
      if (sep === undefined) break; // truncated

      // Nothing we recognize as a separator — guard against an infinite loop.
      if (this.i === before) this.i++;
    }
    if (!closed) this.add("closed_object", openIndex);
    return obj;
  }

  /** The next non-whitespace character without consuming it. */
  private peekNonWs(): string | undefined {
    let j = this.i;
    while (j < this.len && WHITESPACE.has(this.s[j])) j++;
    return this.s[j];
  }

  private parseArray(): unknown[] {
    this.enter();
    try {
      return this.parseArrayBody();
    } finally {
      this.depth--;
    }
  }

  private parseArrayBody(): unknown[] {
    const openIndex = this.i;
    this.i++; // consume "["
    const arr: unknown[] = [];
    let closed = false;
    while (this.i < this.len) {
      this.skipWs();
      const c = this.s[this.i];
      if (c === undefined) break; // truncated
      if (c === "]") {
        this.i++;
        closed = true;
        break;
      }
      if (c === ",") {
        this.add("leading_comma");
        this.i++;
        continue;
      }
      const before = this.i;

      arr.push(this.parseValue());
      this.skipWs();

      const sep = this.s[this.i];
      if (sep === ",") {
        this.i++;
        if (this.peekNonWs() === "]") this.add("trailing_comma");
        continue;
      }
      if (sep === "]") {
        this.i++;
        closed = true;
        break;
      }
      if (sep === undefined) break;

      if (this.i === before) this.i++;
    }
    if (!closed) this.add("closed_array", openIndex);
    return arr;
  }

  private parseString(): string {
    const open = this.s[this.i];
    const close = QUOTE_PAIRS[open] ?? open;
    if (open !== '"') this.add("non_standard_quotes");
    this.i++;
    let out = "";
    while (this.i < this.len) {
      const c = this.s[this.i];
      if (c === "\\") {
        const next = this.s[this.i + 1];
        if (next === undefined) {
          this.i++;
          break;
        }
        if (next === "u") {
          const hex = this.s.slice(this.i + 2, this.i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.i += 6;
            continue;
          }
          out += "u";
          this.i += 2;
          continue;
        }
        out += ESCAPE_CHARS[next] ?? next;
        this.i += 2;
        continue;
      }
      if (c === close) {
        this.i++;
        return out;
      }
      out += c;
      this.i++;
    }
    this.add("closed_string"); // unterminated (truncated) string
    return out;
  }

  private parseUnquotedKey(): string {
    const start = this.i;
    while (this.i < this.len) {
      const c = this.s[this.i];
      if (c === ":" || c === "," || c === "}" || c === "{" || WHITESPACE.has(c)) break;
      this.i++;
    }
    return this.s.slice(start, this.i).trim();
  }

  private parseLiteral(): unknown {
    const start = this.i;
    while (this.i < this.len) {
      const c = this.s[this.i];
      if (
        c === "," ||
        c === "}" ||
        c === "]" ||
        c === ":" ||
        c === "\n" ||
        c === "\r" ||
        c === "\t" ||
        c === " "
      ) {
        break;
      }
      this.i++;
    }
    const raw = this.s.slice(start, this.i).trim();
    const value = interpretLiteral(raw, this.bigint);
    if (raw !== "" && typeof value === "string" && value === raw) {
      this.add("bareword_string", start);
    }
    return value;
  }
}

/** Pull the content out of a markdown code fence, if the input is wrapped in one. */
function stripFences(input: string): { content: string; stripped: boolean } {
  const closed = input.match(/```[a-zA-Z0-9]*[ \t]*\r?\n?([\s\S]*?)```/);
  if (closed?.[1] && closed[1].trim().length > 0) return { content: closed[1], stripped: true };

  // Unclosed fence (common with truncated output): ```json\n{ …
  const open = input.match(/```[a-zA-Z0-9]*[ \t]*\r?\n?([\s\S]*)$/);
  if (open?.[1] && open[1].trim().length > 0) return { content: open[1], stripped: true };

  return { content: input, stripped: false };
}

/** Options accepted by the low-level {@link tolerantParse}. */
export interface ParseOptions {
  readonly maxDepth?: number;
  readonly bigint?: boolean;
}

/** Parsed value plus the list of repairs that produced it. */
export interface DetailedParse {
  value: unknown;
  repairs: RepairEvent[];
}

/**
 * Parse messy, almost-JSON text and report which repairs were applied. Throws
 * {@link SyntaxError} only when no JSON value can be found at all.
 */
export function tolerantParseDetailed(input: string, options?: ParseOptions): DetailedParse {
  const { content, stripped } = stripFences(input);
  const parser = new TolerantParser(content, options);
  const value = parser.parse();
  const repairs = stripped
    ? [{ kind: "code_fence" as const, index: 0 }, ...parser.repairs]
    : parser.repairs;
  return { value, repairs };
}

/**
 * Parse messy, almost-JSON text into a JavaScript value, repairing common
 * problems along the way. Throws {@link SyntaxError} only when no JSON value
 * can be found at all.
 */
export function tolerantParse(input: string, options?: ParseOptions): unknown {
  return tolerantParseDetailed(input, options).value;
}
