import type { ExecutionTarget, Operation } from "@agentick/spec";

const MODEL_CALL_OPS = new Set([
  "model:command:generate",
  "model:command:generate_stream",
  "model:command:run",
]);

/**
 * GenAI-semconv model identity (`gen_ai.request.model` / `gen_ai.system`,
 * verbatim — NOT whitelabeled) for the model-call spans (ADR 78 identity seam).
 *
 * Shared by the real {@link LanguageModelExecutor} and its
 * {@link FakeLanguageModelExecutor} double so both stamp the identical span
 * contract from one source — a copy in the double would drift silently.
 * Returns `{}` for non-model-call ops (e.g. `normalize`) and untargeted input.
 */
export function modelIdentityAttributes(
  op: Operation<unknown, unknown, unknown>,
): Readonly<Record<string, unknown>> {
  if (!MODEL_CALL_OPS.has(op.name)) return {};
  const target = (op.input as { target?: unknown } | undefined)?.target as
    | ExecutionTarget
    | undefined;
  if (target === undefined) return {};
  return { "gen_ai.request.model": target.modelId, "gen_ai.system": target.provider };
}
