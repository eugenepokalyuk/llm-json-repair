import { tolerantParse } from "./parser.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import { JsonRepairError, type RepairErr, type RepairError, type RepairResult } from "./types.js";

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

function ok<T>(value: T, repaired: boolean): RepairResult<T> {
  return { ok: true, value, repaired };
}

function fail(error: RepairError): RepairErr {
  return { ok: false, error };
}

function toParsed(input: string): Parsed | RepairErr {
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
export function repairJson(input: string): RepairResult<unknown>;
export function repairJson<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
): RepairResult<StandardSchemaV1.InferOutput<Schema>>;
export function repairJson(input: string, schema?: StandardSchemaV1): RepairResult<unknown> {
  const parsed = toParsed(input);
  if ("ok" in parsed) return parsed;
  if (!schema) return ok(parsed.value, parsed.repaired);

  const result = schema["~standard"].validate(parsed.value);
  if (result instanceof Promise) {
    return fail({
      code: "async_schema",
      message: "Schema validation is asynchronous; use repairJsonAsync() instead",
    });
  }
  if (result.issues) return validationFailure(result.issues);
  return ok(result.value, parsed.repaired);
}

/** Async counterpart of {@link repairJson}, for schemas that validate asynchronously. */
export async function repairJsonAsync(input: string): Promise<RepairResult<unknown>>;
export async function repairJsonAsync<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
): Promise<RepairResult<StandardSchemaV1.InferOutput<Schema>>>;
export async function repairJsonAsync(
  input: string,
  schema?: StandardSchemaV1,
): Promise<RepairResult<unknown>> {
  const parsed = toParsed(input);
  if ("ok" in parsed) return parsed;
  if (!schema) return ok(parsed.value, parsed.repaired);

  const result = await schema["~standard"].validate(parsed.value);
  if (result.issues) return validationFailure(result.issues);
  return ok(result.value, parsed.repaired);
}

/** Like {@link repairJson}, but returns the value directly and throws {@link JsonRepairError} on failure. */
export function repairJsonOrThrow(input: string): unknown;
export function repairJsonOrThrow<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
): StandardSchemaV1.InferOutput<Schema>;
export function repairJsonOrThrow(input: string, schema?: StandardSchemaV1): unknown {
  const result = schema ? repairJson(input, schema) : repairJson(input);
  if (!result.ok) throw new JsonRepairError(result.error);
  return result.value;
}

/** Async counterpart of {@link repairJsonOrThrow}. */
export async function repairJsonOrThrowAsync(input: string): Promise<unknown>;
export async function repairJsonOrThrowAsync<Schema extends StandardSchemaV1>(
  input: string,
  schema: Schema,
): Promise<StandardSchemaV1.InferOutput<Schema>>;
export async function repairJsonOrThrowAsync(
  input: string,
  schema?: StandardSchemaV1,
): Promise<unknown> {
  const result = schema ? await repairJsonAsync(input, schema) : await repairJsonAsync(input);
  if (!result.ok) throw new JsonRepairError(result.error);
  return result.value;
}

/**
 * Repair broken JSON and return it as a canonical, valid JSON string.
 * Throws {@link JsonRepairError} if nothing parseable is found.
 */
export function repairToString(input: string): string {
  const parsed = toParsed(input);
  if ("ok" in parsed) throw new JsonRepairError(parsed.error);
  return JSON.stringify(parsed.value);
}
