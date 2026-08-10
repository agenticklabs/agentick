/**
 * The structured-output mechanism (three-audiences-plan §B2), shared by the two
 * paths that ask a model for a shape: the loop's multi-tick execution and the
 * session's single-shot reflection pass. Both make the same three decisions —
 * which strategy the target can honor, what the terminal tool looks like, and
 * whether the answer satisfies the schema — so they live here and cannot drift.
 */

import type { OutputSpec, ToolDeclaration } from "./declarations.js";
import type { TargetCapabilities } from "./execution-target.js";
import { parseJsonWithSchema, type StandardSchemaV1 } from "./standard-schema.js";
import { ResponseValidationError } from "../errors/remaining.js";

/** Terminal-tool name when neither the send nor the tree names one. */
export const DEFAULT_TERMINAL_TOOL_NAME = "submit_result";

/**
 * The tool IS the instruction — its presence in the tick's tool list is the
 * "when the task is complete, call this with the final answer" context.
 * Overridable on the output spec (`description`).
 */
const DEFAULT_TERMINAL_TOOL_DESCRIPTION =
  "When the task is complete, call this tool with the final result. Its " +
  "arguments ARE the required answer shape — provide the final answer here " +
  "rather than as prose.";

/**
 * The synthetic structured-output terminal tool. Its `inputSchema` IS the
 * output schema. NEVER registered (no `handlerRef` — the spec firewall, and
 * dispatch of an unregistered handler is a ToolHandlerMissing error): the caller
 * appends it to the model-facing tools list and filters its call out of the
 * dispatch set.
 *
 * `narrate: false` because the injected `_summary` property would land in the
 * arguments, and the arguments are the answer.
 */
export function terminalToolDeclaration(spec: OutputSpec): ToolDeclaration {
  return {
    id: spec.toolName,
    name: spec.toolName,
    description: spec.description ?? DEFAULT_TERMINAL_TOOL_DESCRIPTION,
    inputSchema: spec.schema,
    exposure: ["model"],
    annotations: { narrate: false },
  };
}

/**
 * Resolve the `"auto"` structured-output strategy against the tick's tool count
 * + the target's capabilities (three-audiences-plan §B3 fix #1). The pre-B3
 * policy keyed ONLY on `modelTools > 0`, so a bare `output` send to a target
 * WITHOUT native `json_schema` (e.g. Anthropic — its adapter drops
 * `responseFormat`) resolved to `responseFormat` and reliably failed validation.
 * The terminal-tool strategy is provider-agnostic (tool arguments are
 * constrained natively by every provider), so it is the correct default
 * whenever native structured decoding is absent.
 *
 * Truth table (auto only — an explicit `strategy` on the OutputSpec bypasses
 * this):
 *
 * | tools mounted     | supportsJsonSchema | supportsTools | → strategy       |
 * | ----------------- | ------------------ | ------------- | ---------------- |
 * | yes               | any                | not false     | tool             |
 * | no                | true               | any           | responseFormat   |
 * | no                | false / unset      | not false     | tool             |
 * | any (wanted tool) | —                  | false         | responseFormat † |
 *
 * † The DOUBLE-GAP fallback: the target supports NEITHER native json_schema NOR
 * tools (a text-only model). A tool strategy the provider cannot honor is
 * strictly worse than `responseFormat` (validation still catches non-adherence
 * downstream), so fall back. `supportsTools` and `supportsJsonSchema` both
 * default to their SAFE assumption when unset: tools default present
 * (`!== false`), json_schema default ABSENT (`?? false`) — an unset target is
 * treated as the common tool-capable / no-native-schema provider, which the
 * terminal tool serves.
 *
 * TODO(loop-log): emit a `ctx.log` warning naming the double-gap once the log
 * facet is threaded into the loop tick body (the loop has no `ctx.log` yet —
 * the interceptor-ctx log facet is currently tool-executor + session only).
 */
export function resolveAutoStrategy(
  modelToolCount: number,
  capabilities: TargetCapabilities | undefined,
): "tool" | "responseFormat" {
  const supportsJsonSchema = capabilities?.supportsJsonSchema ?? false;
  const supportsTools = capabilities?.supportsTools;
  const wantsTool = modelToolCount > 0 || !supportsJsonSchema;
  if (!wantsTool) return "responseFormat";
  // Double gap — wants a tool strategy but the target cannot do tools at all.
  return supportsTools === false ? "responseFormat" : "tool";
}

/**
 * What came back for validation: the terminal tool's raw arguments, or the final
 * assistant text under the `responseFormat` strategy.
 */
export type StructuredOutputCapture =
  | { readonly strategy: "tool"; readonly input: unknown }
  | { readonly strategy: "responseFormat"; readonly text: string };

/**
 * Validate a capture against the retained schema. Returns the typed error rather
 * than throwing it, so an Effect caller fails its channel with the same value a
 * Promise caller throws.
 */
export async function validateStructuredOutput(
  schema: StandardSchemaV1,
  capture: StructuredOutputCapture,
): Promise<{ readonly value: unknown } | { readonly error: ResponseValidationError }> {
  if (capture.strategy === "tool") {
    const validated = await schema["~standard"].validate(capture.input);
    if (validated.issues !== undefined) {
      return {
        error: new ResponseValidationError({ raw: capture.input, issues: validated.issues }),
      };
    }
    return { value: validated.value };
  }
  const parsed = await parseJsonWithSchema(capture.text, schema);
  if (!parsed.ok) {
    return {
      error: new ResponseValidationError({
        raw: parsed.text,
        issues: parsed.issues,
        ...(parsed.reason === "invalid-json"
          ? { message: "structured output is not valid JSON" }
          : {}),
      }),
    };
  }
  return { value: parsed.value };
}
