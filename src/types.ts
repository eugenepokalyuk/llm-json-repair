import type { StandardSchemaV1 } from "./standard-schema.js";

/** Discriminated result returned by {@link repairJson} / {@link repairJsonAsync}. */
export type RepairResult<T> = RepairOk<T> | RepairErr;

export interface RepairOk<T> {
  readonly ok: true;
  /** The parsed (and schema-validated, if a schema was given) value. */
  readonly value: T;
  /**
   * `true` when the input was not already valid `JSON.parse`-able JSON and had
   * to be repaired (fences stripped, quotes fixed, truncation closed, …).
   */
  readonly repaired: boolean;
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
