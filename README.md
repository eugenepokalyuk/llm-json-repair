# heal-json

> Repair and validate messy JSON from LLMs and other untrusted sources — type-safe, zero-dependency.

LLMs love to "return JSON" and then wrap it in ```` ```json ````, add a trailing
comma, use `'single quotes'`, prepend "Sure, here you go!", or get cut off
mid-stream. `JSON.parse` throws on all of it. **`heal-json` fixes the JSON, then
optionally validates it against your schema — and gives you back fully typed data.**

```bash
npm install heal-json
```

- 🩹 **Repairs** code fences, prose, trailing/leading commas, single & curly
  quotes, unquoted keys, `//` and `/* */` comments, Python `True/False/None`,
  and **truncated** output (unterminated strings / unclosed brackets).
- 🔒 **Type-safe.** Pass any [Standard Schema](https://standardschema.dev)
  validator (Zod, Valibot, ArkType, …) and get the inferred output type back.
- 🪶 **Zero runtime dependencies.** ESM + CJS, ships its own types.
- 🧯 **Never throws** (unless you ask it to) — failures come back as a
  discriminated `Result`.

## Quick start

```ts
import { heal } from "heal-json";

const raw = '```json\n{ name: "Ada", admin: true, } // the boss\n```';

const result = heal(raw);
if (result.ok) {
  console.log(result.value);    // { name: "Ada", admin: true }
  console.log(result.repaired); // true — input wasn't clean JSON
}
```

## With a schema (recommended)

```ts
import { heal } from "heal-json";
import { z } from "zod";

const User = z.object({ name: z.string(), age: z.number() });

const result = heal("{name:'Ada',age:36,}", User);

if (result.ok) {
  result.value; // typed as { name: string; age: number }
} else {
  result.error.code;   // "validation_error"
  result.error.issues; // standard-schema issues, ready to display
}
```

`heal` returns a discriminated union — no exceptions to catch:

```ts
type HealResult<T> =
  | { ok: true;  value: T; repaired: boolean }
  | { ok: false; error: { code: HealErrorCode; message: string; issues?; cause? } };

type HealErrorCode = "empty_input" | "parse_error" | "validation_error" | "async_schema";
```

## API

| Function | Description |
| --- | --- |
| `heal(input, schema?)` | Repair + (optionally) validate. Returns `HealResult<T>`. |
| `healAsync(input, schema?)` | Same, for schemas with async validation/refinements. |
| `healOrThrow(input, schema?)` | Returns the value directly; throws `HealJsonError` on failure. |
| `healOrThrowAsync(input, schema?)` | Async variant of `healOrThrow`. |
| `repair(input)` | Returns a canonical, valid JSON **string**. |
| `tolerantParse(input)` | The low-level repairing parser → `unknown`. |

### Prefer throwing?

```ts
import { healOrThrow, HealJsonError } from "heal-json";

try {
  const user = healOrThrow(raw, User); // typed
} catch (err) {
  if (err instanceof HealJsonError) {
    console.error(err.code, err.issues);
  }
}
```

## What gets repaired

| Input | Result |
| --- | --- |
| `` ```json\n{"a":1}\n``` `` | `{ a: 1 }` |
| `Here you go: {"a":1}` | `{ a: 1 }` |
| `{"a":1,"b":2,}` | `{ a: 1, b: 2 }` |
| `{'a':1}` / `{a:1}` | `{ a: 1 }` |
| `{"a":True,"b":None}` | `{ a: true, b: null }` |
| `{"a":1,"b":[1,2,3` (truncated) | `{ a: 1, b: [1, 2, 3] }` |

## License

MIT
