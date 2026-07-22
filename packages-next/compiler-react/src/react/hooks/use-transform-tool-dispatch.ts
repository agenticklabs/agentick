/**
 * `useTransformToolDispatch` — a tree-side `transform` over the model's tool
 * calls (ADR 89 §4). A component RESHAPES a dispatch's input and/or result
 * in-path, from render state — e.g. inject a default arg, clamp a value,
 * annotate the result — without touching the tool's own handler.
 *
 * A one-line typed alias over {@link useCommandInterceptor}`("tool:dispatch",
 * "transform", …)`. The middleware is `(input, next, ctx) => result`:
 * `await next(reshapedInput)` to run the tool with altered args, then
 * optionally reshape the returned {@link DispatchResult}.
 *
 * ## THE DISCIPLINE — this runs IN the tool call's critical path
 *
 * The transform is **awaited around the tool body**, so it must be prompt —
 * reshape from captured state and return; it cannot hang the dispatch.
 * Purely observing a dispatch (metrics, spinners) is NOT this — use
 * `useOnToolStart` / `useOnToolEnd`.
 *
 * @example
 * // Force every `search` call to include the user's locale.
 * useTransformToolDispatch(async (input, next) =>
 *   next(input.name === "search" ? { ...input, input: { ...input.input, locale } } : input),
 * );
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 */

import type { AsyncMiddleware } from "@agentick/runtime-next";
import type { DispatchInput, DispatchResult } from "@agentick/spec-next";
import { useCommandInterceptor } from "./use-command-interceptor.js";

export function useTransformToolDispatch(fn: AsyncMiddleware<DispatchInput, DispatchResult>): void {
  useCommandInterceptor("tool:dispatch", "transform", fn as AsyncMiddleware<unknown, unknown>);
}
