import { tolerantParse } from "./parser.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import { type HealErr, type HealError, HealJsonError, type HealResult } from "./types.js";

class EmptyInputError extends Error {}

interface Parsed {
  value: unknown;
  repaired: boolean;
}

function toValue(input: string): Parsed {
  if (typeof input !== "string") {
    // Be forgiving: if someone hands us an already-parsed value, pass it through.
    return { value: input, repaired: false };
  }
  if (input.trim().length === 0) {
    throw new EmptyInputError("Input is empty");
  }
  try {
    return { value: JSON.parse(input), repaired: false };
  } catch {
    return { value: tolerantParse(input), repaired: true };
  }
}

function ok<T>(value: T, repaired: boolean): HealResult<T> {
  return { ok: true, value, repaired };
}

function fail(error: HealError): HealErr {
  return { ok: false, error };
}

function toParsed(input: string): Parsed | HealErr {
  try {
    return toValue(input);
  } catch (cause) {
    if (cause instanceof EmptyInputError) {
      return fail({ code: "empty_input", message: cause.message });
    }
    return fail({
      code: "parse_error",
      message: "Could not parse any JSON value from the input",
      cause,
    });
  }
}

function validationFailure(issues: ReadonlyArray<StandardSchemaV1.Issue>): HealErr {
  const first = issues[0];
  return fail({
    code: "validation_error",
    message: first ? `Validation failed: ${first.message}` : "Validation failed",
    issues,
  });
}

/**
 * Repair messy JSON (LLM output, truncated streams, hand-written config) and,
 * optionally, validate it against a Standard Schema validator (Zod, Valibot,
 * ArkType, …). Never throws — failures come back as `{ ok: false, error }`.
 *
 * @example
 * const r = heal('```json\n{ name: "Ada", admin: true, }\n```');
 * if (r.ok) console.log(r.value); // { name: "Ada", admin: true }
 */
export function heal(input: string): HealResult<unknown>;
export function heal<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
): HealResult<StandardSchemaV1.InferOutput<Schema>>;
export function heal(input: string, schema?: StandardSchemaV1): HealResult<unknown> {
  const parsed = toParsed(input);
  if ("ok" in parsed) return parsed;
  if (!schema) return ok(parsed.value, parsed.repaired);

  const result = schema["~standard"].validate(parsed.value);
  if (result instanceof Promise) {
    return fail({
      code: "async_schema",
      message: "Schema validation is asynchronous; use healAsync() instead",
    });
  }
  if (result.issues) return validationFailure(result.issues);
  return ok(result.value, parsed.repaired);
}

/** Async counterpart of {@link heal}, for schemas that validate asynchronously. */
export async function healAsync(input: string): Promise<HealResult<unknown>>;
export async function healAsync<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
): Promise<HealResult<StandardSchemaV1.InferOutput<Schema>>>;
export async function healAsync(
  input: string,
  schema?: StandardSchemaV1,
): Promise<HealResult<unknown>> {
  const parsed = toParsed(input);
  if ("ok" in parsed) return parsed;
  if (!schema) return ok(parsed.value, parsed.repaired);

  const result = await schema["~standard"].validate(parsed.value);
  if (result.issues) return validationFailure(result.issues);
  return ok(result.value, parsed.repaired);
}

/** Like {@link heal}, but returns the value directly and throws {@link HealJsonError} on failure. */
export function healOrThrow(input: string): unknown;
export function healOrThrow<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
): StandardSchemaV1.InferOutput<Schema>;
export function healOrThrow(input: string, schema?: StandardSchemaV1): unknown {
  const result = schema ? heal(input, schema) : heal(input);
  if (!result.ok) throw new HealJsonError(result.error);
  return result.value;
}

/** Async counterpart of {@link healOrThrow}. */
export async function healOrThrowAsync(input: string): Promise<unknown>;
export async function healOrThrowAsync<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
): Promise<StandardSchemaV1.InferOutput<Schema>>;
export async function healOrThrowAsync(input: string, schema?: StandardSchemaV1): Promise<unknown> {
  const result = schema ? await healAsync(input, schema) : await healAsync(input);
  if (!result.ok) throw new HealJsonError(result.error);
  return result.value;
}

/**
 * Repair messy JSON and return it as a canonical, valid JSON string.
 * Throws {@link HealJsonError} if nothing parseable is found.
 */
export function repair(input: string): string {
  const parsed = toParsed(input);
  if ("ok" in parsed) throw new HealJsonError(parsed.error);
  return JSON.stringify(parsed.value);
}
