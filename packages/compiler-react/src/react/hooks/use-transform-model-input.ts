/**
 * `useTransformModelInput` — a tree-side `transform` over the model call
 * (ADR 89 §4). A component INJECTS context into (or otherwise reshapes) the
 * projected model input in-path, from render state — the last-mile hook
 * between the compiled tree and the provider request.
 *
 * A one-line typed alias over {@link useCommandInterceptor} on BOTH model-call
 * commands — `model:generate` (the non-streaming tick's `fx.run` composes
 * through it) AND `model:generate_stream` (the streaming tick) — so the
 * transform fires on WHICHEVER tick path runs, and (riding the session's
 * tier-4 seam) on WHICHEVER executor a per-tick `<Model>` swap resolves.
 *
 * The middleware is `(input, next, ctx) => output` over the command's input,
 * an `ExecuteInput<LanguageModelInput>`: the model input is `input.targetInput`
 * (its `messages` / `tools` / `parameters`). Reshape it and call
 * `next({ ...input, targetInput: reshaped })`.
 *
 * ## THE DISCIPLINE — this runs IN the model call's critical path
 *
 * The transform is **awaited around the provider call** — the single most
 * expensive op — so it must be prompt: compute the injection from captured
 * state and return. Observing the call (a "thinking…" spinner) is NOT this —
 * use `useOnModelGenerateStart` / `useOnModelGenerateEnd`.
 *
 * @example
 * // Prepend an ephemeral system note the model should see this tick.
 * useTransformModelInput(async (input, next) =>
 *   next({
 *     ...input,
 *     targetInput: {
 *       ...input.targetInput,
 *       messages: [{ role: "system", content: [{ type: "text", text: note }] }, ...input.targetInput.messages],
 *     },
 *   }),
 * );
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 */

import type { AsyncMiddleware } from "@agentick/runtime";
import type { ExecuteInput, LanguageModelInput } from "@agentick/spec";
import { useCommandInterceptor } from "./use-command-interceptor.js";

export function useTransformModelInput(
  fn: AsyncMiddleware<ExecuteInput<LanguageModelInput>, unknown>,
): void {
  const erased = fn as AsyncMiddleware<unknown, unknown>;
  // Both tick paths — the streaming command AND the non-streaming
  // `model:generate` the `fx.run` composes through (ADR 89 §1). Two
  // unconditional registrations (stable hook order).
  useCommandInterceptor("model:generate", "transform", erased);
  useCommandInterceptor("model:generate_stream", "transform", erased);
}
