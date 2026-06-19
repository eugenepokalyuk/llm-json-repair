import type { StandardSchemaV1 } from "./standard-schema.js";

/** Tunables for the repairing parser. All fields are optional. */
export interface RepairOptions {
  /**
   * Maximum nesting depth before the parser bails out with a `parse_error`
   * instead of overflowing the call stack. Defaults to `512`.
   */
  readonly maxDepth?: number;
  /**
   * Parse integers that exceed `Number.MAX_SAFE_INTEGER` as `bigint` instead
   * of letting them lose precision. Defaults to `false`. Note: `bigint` values
   * are not JSON-serializable, so avoid this with {@link repairToString}.
   */
  readonly bigint?: boolean;
}

/** Discriminated result returned by {@link repairJson} / {@link repairJsonAsync}. */
export type RepairResult<T> = RepairOk<T> | RepairErr;

/**
 * Incremental parser for JSON that arrives in pieces — typically a streaming
 * LLM response. Feed it chunks as they land; each call returns the best-effort
 * value parsed from everything seen so far, with truncated structures closed.
 */
export interface RepairStream<T> {
  /**
   * Append a chunk and return the best-effort value for the buffer so far.
   * No schema validation runs here (the data is usually still incomplete) —
   * the typed value is a best-effort projection. Use {@link RepairStream.end}
   * for the final, validated result.
   */
  push(chunk: string): RepairResult<T>;
  /** Re-parse the current buffer without appending anything. */
  current(): RepairResult<T>;
  /** Finalize: parse and (if a schema was provided) validate the full buffer. */
  end(): RepairResult<T>;
  /** All raw text accumulated so far. */
  readonly buffer: string;
}

/** A single repair the parser applied, for logging and quality metrics. */
export type RepairKind =
  | "code_fence" // stripped a markdown ``` fence
  | "surrounding_prose" // dropped text before the JSON value
  | "comment" // removed a // or /* */ comment
  | "leading_comma" // dropped a stray/leading comma
  | "trailing_comma" // dropped a trailing comma
  | "unquoted_key" // quoted an unquoted object key
  | "non_standard_quotes" // normalized single/smart/backtick quotes
  | "bareword_string" // kept an unquoted bareword as a string
  | "closed_string" // closed a truncated string
  | "closed_object" // closed a truncated object
  | "closed_array"; // closed a truncated array

export interface RepairEvent {
  readonly kind: RepairKind;
  /** Offset into the parsed content (after fence-stripping) where it happened. */
  readonly index?: number;
}

export interface RepairOk<T> {
  readonly ok: true;
  /** The parsed (and schema-validated, if a schema was given) value. */
  readonly value: T;
  /**
   * `true` when the input was not already valid `JSON.parse`-able JSON and had
   * to be repaired (fences stripped, quotes fixed, truncation closed, …).
   */
  readonly repaired: boolean;
  /**
   * The specific repairs that were applied, in order. Empty when the input was
   * already valid JSON. Best-effort: `repaired` may be `true` with an empty
   * list if a repair fell outside the categorized kinds.
   */
  readonly repairs: ReadonlyArray<RepairEvent>;
}

export interface RepairErr {
  readonly ok: false;
  readonly error: RepairError;
}

export type RepairErrorCode = "empty_input" | "parse_error" | "validation_error" | "async_schema";

export interface RepairError {
  readonly code: RepairErrorCode;
  readonly message: string;
  /** Present when `code === "validation_error"`. */
  readonly issues?: ReadonlyArray<StandardSchemaV1.Issue>;
  /** The underlying thrown value, when there was one. */
  readonly cause?: unknown;
}

/** Thrown by {@link repairJsonOrThrow} / {@link repairJsonOrThrowAsync} on failure. */
export class JsonRepairError extends Error {
  readonly code: RepairErrorCode;
  readonly issues?: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(error: RepairError) {
    super(error.message, { cause: error.cause });
    this.name = "JsonRepairError";
    this.code = error.code;
    this.issues = error.issues;
  }
}
