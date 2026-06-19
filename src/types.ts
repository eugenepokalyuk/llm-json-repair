import type { StandardSchemaV1 } from "./standard-schema.js";

/** Discriminated result returned by {@link heal} / {@link healAsync}. */
export type HealResult<T> = HealOk<T> | HealErr;

export interface HealOk<T> {
  readonly ok: true;
  /** The parsed (and schema-validated, if a schema was given) value. */
  readonly value: T;
  /**
   * `true` when the input was not already valid `JSON.parse`-able JSON and had
   * to be repaired (fences stripped, quotes fixed, truncation closed, …).
   */
  readonly repaired: boolean;
}

export interface HealErr {
  readonly ok: false;
  readonly error: HealError;
}

export type HealErrorCode = "empty_input" | "parse_error" | "validation_error" | "async_schema";

export interface HealError {
  readonly code: HealErrorCode;
  readonly message: string;
  /** Present when `code === "validation_error"`. */
  readonly issues?: ReadonlyArray<StandardSchemaV1.Issue>;
  /** The underlying thrown value, when there was one. */
  readonly cause?: unknown;
}

/** Thrown by {@link healOrThrow} / {@link healOrThrowAsync} on failure. */
export class HealJsonError extends Error {
  readonly code: HealErrorCode;
  readonly issues?: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(error: HealError) {
    super(error.message, { cause: error.cause });
    this.name = "HealJsonError";
    this.code = error.code;
    this.issues = error.issues;
  }
}
