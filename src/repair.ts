import { tolerantParseDetailed } from "./parser.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import {
  JsonRepairError,
  type RepairErr,
  type RepairError,
  type RepairEvent,
  type RepairOptions,
  type RepairResult,
} from "./types.js";

class EmptyInputError extends Error {}

interface Parsed {
  value: unknown;
  repaired: boolean;
  repairs: ReadonlyArray<RepairEvent>;
}

const NO_REPAIRS: ReadonlyArray<RepairEvent> = [];

/**
 * The optional second argument may be a Standard Schema validator or a plain
 * {@link RepairOptions} bag — a schema is recognizable by its `~standard` key.
 */
function isSchema(value: unknown): value is StandardSchemaV1 {
  return typeof value === "object" && value !== null && "~standard" in value;
}

function normalizeArgs(
  schemaOrOptions?: StandardSchemaV1 | RepairOptions,
  maybeOptions?: RepairOptions,
): { schema?: StandardSchemaV1; options?: RepairOptions } {
  if (isSchema(schemaOrOptions)) {
    return { schema: schemaOrOptions, options: maybeOptions };
  }
  return { schema: undefined, options: schemaOrOptions };
}

function toValue(input: string, options?: RepairOptions): Parsed {
  if (typeof input !== "string") {
    // Be forgiving: if someone hands us an already-parsed value, pass it through.
    return { value: input, repaired: false, repairs: NO_REPAIRS };
  }
  if (input.trim().length === 0) {
    throw new EmptyInputError("Input is empty");
  }
  if (options?.bigint) {
    // `JSON.parse` can never produce a bigint, so the tolerant parser is the
    // only path that can honor this option. We still report `repaired` based on
    // whether the input was valid JSON, not on the bigint upgrade itself.
    let repaired = true;
    try {
      JSON.parse(input);
      repaired = false;
    } catch {}
    const detailed = tolerantParseDetailed(input, options);
    return { value: detailed.value, repaired, repairs: detailed.repairs };
  }
  try {
    return { value: JSON.parse(input), repaired: false, repairs: NO_REPAIRS };
  } catch {
    const detailed = tolerantParseDetailed(input, options);
    return { value: detailed.value, repaired: true, repairs: detailed.repairs };
  }
}

function ok<T>(value: T, repaired: boolean, repairs: ReadonlyArray<RepairEvent>): RepairResult<T> {
  return { ok: true, value, repaired, repairs };
}

function fail(error: RepairError): RepairErr {
  return { ok: false, error };
}

function toParsed(input: string, options?: RepairOptions): Parsed | RepairErr {
  try {
    return toValue(input, options);
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

function validationFailure(issues: ReadonlyArray<StandardSchemaV1.Issue>): RepairErr {
  const first = issues[0];
  return fail({
    code: "validation_error",
    message: first ? `Validation failed: ${first.message}` : "Validation failed",
    issues,
  });
}

/**
 * Repair broken JSON (LLM output, truncated streams, hand-written config) and,
 * optionally, validate it against a Standard Schema validator (Zod, Valibot,
 * ArkType, …). Never throws — failures come back as `{ ok: false, error }`.
 *
 * @example
 * const r = repairJson('```json\n{ name: "Ada", admin: true, }\n```');
 * if (r.ok) console.log(r.value); // { name: "Ada", admin: true }
 */
export function repairJson(input: string, options?: RepairOptions): RepairResult<unknown>;
export function repairJson<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
  options?: RepairOptions,
): RepairResult<StandardSchemaV1.InferOutput<Schema>>;
export function repairJson(
  input: string,
  schemaOrOptions?: StandardSchemaV1 | RepairOptions,
  maybeOptions?: RepairOptions,
): RepairResult<unknown> {
  const { schema, options } = normalizeArgs(schemaOrOptions, maybeOptions);
  const parsed = toParsed(input, options);
  if ("ok" in parsed) return parsed;
  if (!schema) return ok(parsed.value, parsed.repaired, parsed.repairs);

  const result = schema["~standard"].validate(parsed.value);
  if (result instanceof Promise) {
    return fail({
      code: "async_schema",
      message: "Schema validation is asynchronous; use repairJsonAsync() instead",
    });
  }
  if (result.issues) return validationFailure(result.issues);
  return ok(result.value, parsed.repaired, parsed.repairs);
}

/** Async counterpart of {@link repairJson}, for schemas that validate asynchronously. */
export async function repairJsonAsync(
  input: string,
  options?: RepairOptions,
): Promise<RepairResult<unknown>>;
export async function repairJsonAsync<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
  options?: RepairOptions,
): Promise<RepairResult<StandardSchemaV1.InferOutput<Schema>>>;
export async function repairJsonAsync(
  input: string,
  schemaOrOptions?: StandardSchemaV1 | RepairOptions,
  maybeOptions?: RepairOptions,
): Promise<RepairResult<unknown>> {
  const { schema, options } = normalizeArgs(schemaOrOptions, maybeOptions);
  const parsed = toParsed(input, options);
  if ("ok" in parsed) return parsed;
  if (!schema) return ok(parsed.value, parsed.repaired, parsed.repairs);

  const result = await schema["~standard"].validate(parsed.value);
  if (result.issues) return validationFailure(result.issues);
  return ok(result.value, parsed.repaired, parsed.repairs);
}

/** Like {@link repairJson}, but returns the value directly and throws {@link JsonRepairError} on failure. */
export function repairJsonOrThrow(input: string, options?: RepairOptions): unknown;
export function repairJsonOrThrow<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
  options?: RepairOptions,
): StandardSchemaV1.InferOutput<Schema>;
export function repairJsonOrThrow(
  input: string,
  schemaOrOptions?: StandardSchemaV1 | RepairOptions,
  maybeOptions?: RepairOptions,
): unknown {
  const result = repairJson(input, schemaOrOptions as StandardSchemaV1, maybeOptions);
  if (!result.ok) throw new JsonRepairError(result.error);
  return result.value;
}

/** Async counterpart of {@link repairJsonOrThrow}. */
export async function repairJsonOrThrowAsync(
  input: string,
  options?: RepairOptions,
): Promise<unknown>;
export async function repairJsonOrThrowAsync<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
  options?: RepairOptions,
): Promise<StandardSchemaV1.InferOutput<Schema>>;
export async function repairJsonOrThrowAsync(
  input: string,
  schemaOrOptions?: StandardSchemaV1 | RepairOptions,
  maybeOptions?: RepairOptions,
): Promise<unknown> {
  const result = await repairJsonAsync(input, schemaOrOptions as StandardSchemaV1, maybeOptions);
  if (!result.ok) throw new JsonRepairError(result.error);
  return result.value;
}

/**
 * Repair broken JSON and return it as a canonical, valid JSON string.
 * Throws {@link JsonRepairError} if nothing parseable is found.
 */
export function repairToString(input: string, options?: RepairOptions): string {
  const parsed = toParsed(input, options);
  if ("ok" in parsed) throw new JsonRepairError(parsed.error);
  return JSON.stringify(parsed.value);
}
