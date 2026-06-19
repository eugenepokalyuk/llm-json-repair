# llm-json-repair

[![CI](https://github.com/eugenepokalyuk/llm-json-repair/actions/workflows/ci.yml/badge.svg)](https://github.com/eugenepokalyuk/llm-json-repair/actions/workflows/ci.yml)
![types](https://img.shields.io/badge/types-included-blue)
![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)

Repair and parse **broken JSON from LLM output** (OpenAI, Claude, …) — strips code
fences, fixes trailing commas and single quotes, closes truncated streams, then
**optionally validates against your schema** and gives you back fully typed data.
Tree-shakeable, ships ESM + CJS + types, and has **zero runtime dependencies**

> The problem: LLMs love to "return JSON" and then wrap it in ```` ```json ````,
> add a trailing comma, use `'single quotes'`, prepend "Sure, here you go!", or
> get cut off mid-stream. `JSON.parse` throws on all of it. This library fixes the
> JSON first, then validates it — once, correctly, without exceptions to catch

## At a glance

| Export | What it does |
| --- | --- |
| [`repairJson`](#repairjsoninput-schema-options) | Repair + (optionally) validate → typed `RepairResult<T>` |
| [`repairJsonAsync`](#async-schemas) | Same, for schemas with async validation/refinements |
| [`repairJsonOrThrow`](#prefer-throwing) | Returns the value directly; throws on failure |
| [`repairJsonOrThrowAsync`](#prefer-throwing) | Async variant of `repairJsonOrThrow` |
| [`repairJsonStream`](#streaming) | Incremental parser for JSON arriving in chunks |
| [`repairJsonFromStream`](#streaming) | Drain an `AsyncIterable<string>` → final result |
| [`repairToString`](#repairtostring) | Repair and return a canonical, valid JSON **string** |
| [`tolerantParse`](#tolerantparse) | The low-level repairing parser → `unknown` |

There's also a [CLI](#cli) for piping JSON through the repairer from a shell.

## Install

```bash
npm install llm-json-repair
```

`node >= 18`. No runtime dependencies — bring your own [Standard Schema](https://standardschema.dev)
validator (Zod, Valibot, ArkType, …) only if you want validation

## Quick start

```ts
import { repairJson } from "llm-json-repair";

const raw = '```json\n{ name: "Ada", admin: true, } // the boss\n```';

const result = repairJson(raw);
if (result.ok) {
  console.log(result.value);    // { name: "Ada", admin: true }
  console.log(result.repaired); // true — input wasn't clean JSON
}
```

## `repairJson(input, schema?, options?)`

Repairs messy JSON and, if you pass a schema, validates the result and infers the
output type. **Never throws** — failures come back as a discriminated union:

```ts
import { repairJson } from "llm-json-repair";
import { z } from "zod";

const User = z.object({ name: z.string(), age: z.number() });

const result = repairJson("{name:'Ada',age:36,}", User);

if (result.ok) {
  result.value; // typed as { name: string; age: number }
} else {
  result.error.code;   // "validation_error"
  result.error.issues; // standard-schema issues, ready to display
}
```

```ts
type RepairResult<T> =
  | { ok: true;  value: T; repaired: boolean; repairs: RepairEvent[] }
  | { ok: false; error: { code: RepairErrorCode; message: string; issues?; cause? } };

type RepairErrorCode = "empty_input" | "parse_error" | "validation_error" | "async_schema";
```

| Field | Description |
| --- | --- |
| `value` | The parsed (and schema-validated, if a schema was given) value |
| `repaired` | `true` when the input wasn't already `JSON.parse`-able and had to be repaired |
| `repairs` | The [specific fixes](#inspecting-the-repairs) that were applied, in order |
| `error.code` | Discriminator for the failure — branch on it without parsing messages |
| `error.issues` | Standard Schema issues, present on `validation_error` |

### What gets repaired

| Input | Result |
| --- | --- |
| `` ```json\n{"a":1}\n``` `` | `{ a: 1 }` |
| `Here you go: {"a":1}` | `{ a: 1 }` |
| `{"a":1,"b":2,}` | `{ a: 1, b: 2 }` |
| `{'a':1}` / `{a:1}` | `{ a: 1 }` |
| `{"a":True,"b":None}` | `{ a: true, b: null }` |
| `{"a":1,"b":[1,2,3` (truncated) | `{ a: 1, b: [1, 2, 3] }` |
| `// comment` + `/* block */` | stripped |

## Async schemas

For schemas with async validation or refinements, use `repairJsonAsync` — the
sync `repairJson` returns an `async_schema` error if it encounters one:

```ts
import { repairJsonAsync } from "llm-json-repair";

const result = await repairJsonAsync(raw, MyAsyncSchema);
```

## Prefer throwing?

`repairJsonOrThrow` (and its async variant) return the value directly and throw a
`JsonRepairError` carrying the same `code` and `issues`:

```ts
import { repairJsonOrThrow, JsonRepairError } from "llm-json-repair";

try {
  const user = repairJsonOrThrow(raw, User); // typed
} catch (err) {
  if (err instanceof JsonRepairError) {
    console.error(err.code, err.issues);
  }
}
```

## `repairToString`

When you just want clean JSON text back (not a parsed value), `repairToString`
repairs the input and re-serializes it canonically. Throws `JsonRepairError` if
nothing parseable is found:

```ts
import { repairToString } from "llm-json-repair";

repairToString("{name:'Ada',}"); // '{"name":"Ada"}'
```

## Streaming

LLMs emit structured output token by token. `repairJsonStream` parses the buffer
as it grows, closing whatever isn't finished yet, so you can render a live,
partial UI. `push()` returns the best-effort value so far; `end()` runs the final
schema validation:

```ts
import { repairJsonStream } from "llm-json-repair";

const stream = repairJsonStream(User);

for await (const token of llm) {
  const partial = stream.push(token);
  if (partial.ok) render(partial.value); // updates as tokens arrive
}

const final = stream.end(); // validated against `User`
```

Prefer to hand over an async iterable? `repairJsonFromStream` drains it for you
and reports each partial via `onPartial`:

```ts
import { repairJsonFromStream } from "llm-json-repair";

const result = await repairJsonFromStream(response, User, {
  onPartial: (p) => p.ok && render(p.value),
});
```

> During streaming the schema is **not** applied (partial data would fail
> validation) — `push()` gives you the best-effort value, and validation runs
> once at `end()`.

## Inspecting the repairs

Every successful result carries a `repairs` array describing exactly what was
changed — handy for logging or measuring how messy a model's output is:

```ts
const r = repairJson("```json\n{name:'Ada',}\n```");
r.ok && r.repairs.map((e) => e.kind);
// ["code_fence", "unquoted_key", "non_standard_quotes", "trailing_comma"]
```

Kinds: `code_fence`, `surrounding_prose`, `comment`, `leading_comma`,
`trailing_comma`, `unquoted_key`, `non_standard_quotes`, `bareword_string`,
`closed_string`, `closed_object`, `closed_array`. Each event also has an `index`
into the parsed content.

## Options

All `repair*` functions accept a `RepairOptions` bag — as the **second** argument
when there's no schema, or the **third** alongside one:

```ts
repairJson(raw, { maxDepth: 64 });
repairJson(raw, User, { bigint: true });
```

| Option | Default | Description |
| --- | --- | --- |
| `maxDepth` | `512` | Nesting limit; deeper input fails with `parse_error` instead of overflowing the stack |
| `bigint` | `false` | Parse integers beyond `Number.MAX_SAFE_INTEGER` as `bigint` instead of losing precision |

## `tolerantParse`

The low-level repairing parser. Takes a string, returns `unknown` (no schema, no
`Result` wrapper) — useful if you want to plug repair into your own pipeline:

```ts
import { tolerantParse } from "llm-json-repair";

const value = tolerantParse("[1,2,3,"); // [1, 2, 3]
```

## CLI

The package ships an `llm-json-repair` bin that repairs JSON from a file or stdin
and prints canonical JSON to stdout:

```bash
cat broken.json | llm-json-repair          # repair a file/stream
llm-json-repair data.json --pretty         # pretty-print
echo '{a:1,b:2,}' | npx llm-json-repair    # one-off, no install
```

Flags: `--pretty`, `--bigint`, `--quiet`, `--help`, `--version`. Exits `1` when
nothing parseable is found.

## Benchmarks

Run `npm run bench` (Vitest, vs [`jsonrepair`](https://github.com/josdejong/jsonrepair)).
Indicative numbers on an M-series laptop, higher is better:

| Input | `llm-json-repair` | `jsonrepair` |
| --- | --- | --- |
| clean JSON | **91k ops/s** | 7k ops/s |
| messy (quotes, comments, commas) | 125k ops/s | 131k ops/s |
| truncated | **16k ops/s** | 8k ops/s |
| markdown-fenced | **14k ops/s** | — (not supported) |

Clean input takes a `JSON.parse` fast path, so there's no repair overhead until
something is actually broken. Your numbers will vary with payload and hardware.

## Development

```bash
npm install
npm test          # Vitest (incl. fast-check property tests)
npm run bench     # Vitest benchmarks vs jsonrepair
npm run lint      # Biome
npm run typecheck
npm run build     # ESM + CJS + .d.ts via tsup
```

## License

[MIT](./LICENSE) © Evgenii Pokalyuk
