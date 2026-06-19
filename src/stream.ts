import { repairJson } from "./repair.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import type { RepairOptions, RepairResult, RepairStream } from "./types.js";

class JsonRepairStream<T> implements RepairStream<T> {
  private buf = "";

  constructor(
    private readonly schema: StandardSchemaV1 | undefined,
    private readonly options: RepairOptions | undefined,
  ) {}

  get buffer(): string {
    return this.buf;
  }

  push(chunk: string): RepairResult<T> {
    this.buf += chunk;
    return this.current();
  }

  current(): RepairResult<T> {
    // No schema while streaming: partial data would spuriously fail validation.
    return repairJson(this.buf, this.options) as RepairResult<T>;
  }

  end(): RepairResult<T> {
    return (
      this.schema
        ? repairJson(this.buf, this.schema, this.options)
        : repairJson(this.buf, this.options)
    ) as RepairResult<T>;
  }
}

/**
 * Create an incremental parser for JSON that arrives in chunks (a streaming LLM
 * response, an SSE feed, …). Each {@link RepairStream.push} returns the
 * best-effort value parsed so far — perfect for rendering a partial UI as
 * tokens land — and {@link RepairStream.end} produces the final, schema-checked
 * result.
 *
 * @example
 * const stream = repairJsonStream(User);
 * for await (const token of llm) {
 *   const partial = stream.push(token);
 *   if (partial.ok) render(partial.value); // updates live
 * }
 * const final = stream.end(); // validated against `User`
 */
export function repairJsonStream(options?: RepairOptions): RepairStream<unknown>;
export function repairJsonStream<Schema extends StandardSchemaV1>(
  schema: Schema,
  options?: RepairOptions,
): RepairStream<StandardSchemaV1.InferOutput<Schema>>;
export function repairJsonStream(
  schemaOrOptions?: StandardSchemaV1 | RepairOptions,
  maybeOptions?: RepairOptions,
): RepairStream<unknown> {
  const isSchema =
    typeof schemaOrOptions === "object" &&
    schemaOrOptions !== null &&
    "~standard" in schemaOrOptions;
  const schema = isSchema ? (schemaOrOptions as StandardSchemaV1) : undefined;
  const options = isSchema ? maybeOptions : (schemaOrOptions as RepairOptions | undefined);
  return new JsonRepairStream(schema, options);
}

/**
 * Drain an async iterable of string chunks through a {@link repairJsonStream}
 * and return the final, validated result. The optional `onPartial` callback
 * fires with the best-effort value after each chunk.
 */
export async function repairJsonFromStream(
  source: AsyncIterable<string>,
  options?: RepairOptions & { onPartial?: (partial: RepairResult<unknown>) => void },
): Promise<RepairResult<unknown>>;
export async function repairJsonFromStream<Schema extends StandardSchemaV1>(
  source: AsyncIterable<string>,
  schema: Schema,
  options?: RepairOptions & {
    onPartial?: (partial: RepairResult<StandardSchemaV1.InferOutput<Schema>>) => void;
  },
): Promise<RepairResult<StandardSchemaV1.InferOutput<Schema>>>;
export async function repairJsonFromStream(
  source: AsyncIterable<string>,
  schemaOrOptions?:
    | StandardSchemaV1
    | (RepairOptions & { onPartial?: (p: RepairResult<unknown>) => void }),
  maybeOptions?: RepairOptions & { onPartial?: (p: RepairResult<unknown>) => void },
): Promise<RepairResult<unknown>> {
  const isSchema =
    typeof schemaOrOptions === "object" &&
    schemaOrOptions !== null &&
    "~standard" in schemaOrOptions;
  const schema = isSchema ? (schemaOrOptions as StandardSchemaV1) : undefined;
  const opts = (isSchema ? maybeOptions : schemaOrOptions) as
    | (RepairOptions & { onPartial?: (p: RepairResult<unknown>) => void })
    | undefined;
  const onPartial = opts?.onPartial;

  const stream = schema ? repairJsonStream(schema, opts) : repairJsonStream(opts);
  for await (const chunk of source) {
    const partial = stream.push(chunk);
    onPartial?.(partial);
  }
  return stream.end();
}
