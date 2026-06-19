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
| [`repairJson`](#repairjsoninput-schema) | Repair + (optionally) validate → typed `RepairResult<T>` |
| [`repairJsonAsync`](#async-schemas) | Same, for schemas with async validation/refinements |
| [`repairJsonOrThrow`](#prefer-throwing) | Returns the value directly; throws on failure |
| [`repairJsonOrThrowAsync`](#prefer-throwing) | Async variant of `repairJsonOrThrow` |
| [`repairToString`](#repairtostring) | Repair and return a canonical, valid JSON **string** |
| [`tolerantParse`](#tolerantparse) | The low-level repairing parser → `unknown` |

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

## `repairJson(input, schema?)`

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
  | { ok: true;  value: T; repaired: boolean }
  | { ok: false; error: { code: RepairErrorCode; message: string; issues?; cause? } };

type RepairErrorCode = "empty_input" | "parse_error" | "validation_error" | "async_schema";
```

| Field | Description |
| --- | --- |
| `value` | The parsed (and schema-validated, if a schema was given) value |
| `repaired` | `true` when the input wasn't already `JSON.parse`-able and had to be repaired |
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

## `tolerantParse`

The low-level repairing parser. Takes a string, returns `unknown` (no schema, no
`Result` wrapper) — useful if you want to plug repair into your own pipeline:

```ts
import { tolerantParse } from "llm-json-repair";

const value = tolerantParse("[1,2,3,"); // [1, 2, 3]
```

## Development

```bash
npm install
npm test          # Vitest
npm run lint      # Biome
npm run typecheck
npm run build     # ESM + CJS + .d.ts via tsup
```

## License

[MIT](./LICENSE) © Evgenii Pokalyuk
