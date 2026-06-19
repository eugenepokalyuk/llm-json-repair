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

function interpretLiteral(raw: string): unknown {
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
      return null;
  }
  const num = Number(raw);
  if (!Number.isNaN(num)) {
    if (num === Number.POSITIVE_INFINITY || num === Number.NEGATIVE_INFINITY) return null;
    return num;
  }
  // Unrecognized bareword: treat it as a string rather than failing.
  return raw;
}

class TolerantParser {
  private i = 0;
  private readonly s: string;
  private readonly len: number;

  constructor(source: string) {
    this.s = source;
    this.len = source.length;
  }

  parse(): unknown {
    const start = this.findStructStart();
    if (start >= 0) {
      this.i = start;
    } else {
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
        this.i += 2;
        while (this.i < this.len && this.s[this.i] !== "\n") this.i++;
      } else if (c === "/" && this.s[this.i + 1] === "*") {
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
    this.i++; // consume "{"
    const obj: Record<string, unknown> = {};
    while (this.i < this.len) {
      this.skipWs();
      const c = this.s[this.i];
      if (c === undefined) break; // truncated
      if (c === "}") {
        this.i++;
        break;
      }
      if (c === ",") {
        // stray / leading comma
        this.i++;
        continue;
      }
      const before = this.i;

      const key = isOpenQuote(c) ? this.parseString() : this.parseUnquotedKey();

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
        continue;
      }
      if (sep === "}") {
        this.i++;
        break;
      }
      if (sep === undefined) break; // truncated

      // Nothing we recognize as a separator — guard against an infinite loop.
      if (this.i === before) this.i++;
    }
    return obj;
  }

  private parseArray(): unknown[] {
    this.i++; // consume "["
    const arr: unknown[] = [];
    while (this.i < this.len) {
      this.skipWs();
      const c = this.s[this.i];
      if (c === undefined) break; // truncated
      if (c === "]") {
        this.i++;
        break;
      }
      if (c === ",") {
        this.i++;
        continue;
      }
      const before = this.i;

      arr.push(this.parseValue());
      this.skipWs();

      const sep = this.s[this.i];
      if (sep === ",") {
        this.i++;
        continue;
      }
      if (sep === "]") {
        this.i++;
        break;
      }
      if (sep === undefined) break;

      if (this.i === before) this.i++;
    }
    return arr;
  }

  private parseString(): string {
    const open = this.s[this.i];
    const close = QUOTE_PAIRS[open] ?? open;
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
    return out; // unterminated (truncated) string
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
    return interpretLiteral(this.s.slice(start, this.i).trim());
  }
}

/** Pull the content out of a markdown code fence, if the input is wrapped in one. */
function stripFences(input: string): string {
  const closed = input.match(/```[a-zA-Z0-9]*[ \t]*\r?\n?([\s\S]*?)```/);
  if (closed?.[1] && closed[1].trim().length > 0) return closed[1];

  // Unclosed fence (common with truncated output): ```json\n{ …
  const open = input.match(/```[a-zA-Z0-9]*[ \t]*\r?\n?([\s\S]*)$/);
  if (open?.[1] && open[1].trim().length > 0) return open[1];

  return input;
}

/**
 * Parse messy, almost-JSON text into a JavaScript value, repairing common
 * problems along the way. Throws {@link SyntaxError} only when no JSON value
 * can be found at all.
 */
export function tolerantParse(input: string): unknown {
  return new TolerantParser(stripFences(input)).parse();
}
