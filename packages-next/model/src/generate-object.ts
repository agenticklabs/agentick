/**
 * `generateObject()` — typed structured output over any adapter (#184).
 *
 * Sets `responseFormat: { type: "json_schema" }` from a Standard Schema
 * (the same currency the command registry uses), runs a single-shot
 * `generate`, and parses + validates the text output into a typed value.
 *
 * ```ts
 * const { object } = await generateObject({
 *   model: openai("gpt-4o"),
 *   schema: invoiceSchema,          // any StandardSchemaV1 (zod, etc.)
 *   messages,
 * });
 * ```
 *
 * **Normalize, translate, escape-hatch (ratified 2026-07-04):** the
 * canonical knob (`responseFormat`) is normalized here; each adapter
 * TRANSLATES it to its provider dialect; and `providerOptions.<ns>`
 * spreads LAST in every adapter's buildParams, so explicit
 * provider-specific overrides always win over the canonical mapping.
 *
 * Providers with native json_schema support advertise
 * `capabilities.supportsJsonSchema` (openai, google map it natively;
 * anthropic drops responseFormat — its adapter TODO(trail-anthropic-
 * structured) is the tool-shaped strategy; ai-sdk TODO(trail-aisdk-
 * experimental-output) maps to `experimental_output`). Validation
 * catches non-adherence regardless.
 *
 * // TODO(trail-object-repair): compose a repair strategy (#179's
 * // repair-hook shape) — on parse/validation failure, one cheap-model
 * // repair round before throwing.
 * // TODO(trail-response-format-send): surface responseFormat on the
 * // session tier's SendInput for structured final turns.
 */

import type {
  LanguageModelExecutionResult,
  StandardSchemaIssue,
  StandardSchemaV1,
} from "@agentick/spec-next";
import { toJsonSchema } from "@agentick/spec-next";

import { generate, type GenerateOptions } from "./generate.js";

export interface GenerateObjectOptions<
  T = unknown,
  TRaw = unknown,
  TChunk = unknown,
> extends GenerateOptions<TRaw, TChunk> {
  /** Standard Schema for the expected object (zod, effect/schema, jsonSchema(), ...). */
  readonly schema: StandardSchemaV1<unknown, T>;
  /** Schema name forwarded to providers that want one. Default "response". */
  readonly schemaName?: string;
}

export interface GenerateObjectResult<T> {
  readonly object: T;
  /** The underlying execution result (usage, stopReason, raw). */
  readonly result: LanguageModelExecutionResult;
}

/** Thrown when the model's output is not JSON or fails schema validation. */
export class GenerateObjectError extends Error {
  constructor(
    message: string,
    /** The raw text the model produced. */
    readonly text: string,
    /** Standard Schema issues (empty for JSON parse failures). */
    readonly issues: readonly StandardSchemaIssue[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GenerateObjectError";
  }
}

export async function generateObject<T, TRaw, TChunk>(
  options: GenerateObjectOptions<T, TRaw, TChunk>,
): Promise<GenerateObjectResult<T>> {
  const { schema, schemaName, ...rest } = options;
  const result = await generate({
    ...rest,
    parameters: {
      ...options.parameters,
      responseFormat: {
        type: "json_schema",
        name: schemaName ?? "response",
        schema: toJsonSchema(schema) as Record<string, unknown>,
      },
    },
  });

  const text = result.output
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new GenerateObjectError("model output is not valid JSON", text, [], { cause });
  }

  const validated = await schema["~standard"].validate(parsed);
  if (validated.issues) {
    throw new GenerateObjectError(
      `model output failed schema validation: ${validated.issues.map((i) => i.message).join("; ")}`,
      text,
      validated.issues,
    );
  }
  return { object: validated.value, result };
}
