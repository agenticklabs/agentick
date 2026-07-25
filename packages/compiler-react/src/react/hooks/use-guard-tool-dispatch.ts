/**
 * `useGuardToolDispatch` — the flagship tree-side guard (ADR 89 §4). A
 * component ADMITS, DENIES, DEFERS, or REPLACES the model's tool calls from
 * its render state — the tree declaring the agent's admission control, the
 * same move it already makes for tools / knobs / `gate()`.
 *
 * A one-line typed alias over {@link useCommandInterceptor}`("tool:dispatch",
 * "guard", …)`: the decider sees the typed `DispatchInput` (name,
 * `toolCallId`, validated `input`, work-path `context`) and returns a
 * {@link GuardDecision} — `"proceed"` / `"veto"` / `"defer"` / `{ replace }`
 * (or the full `HandlerVerdict` for `reason` / `retryAfter`).
 *
 * ## THE DISCIPLINE — this runs IN the tool call's critical path
 *
 * The decider is **awaited before the tool body**, so it must decide
 * **promptly** from captured state or **defer cleanly** — it cannot hang the
 * dispatch. Two ways to route a human into the loop:
 *
 *   - **`"defer"`** — suspend the dispatch → terminal `deferred` (the caller
 *     retries later); fire-and-return, don't block.
 *   - **await an elicitation** — the `<ToolGate>` confirm-dialog pattern:
 *     `async (input) => (await confirm(input)) ? "proceed" : "veto"`, where
 *     `confirm` drives `bridges.elicitation` (a bounded, abortable ask).
 *     The guard suspends the tool call on the confirm and resumes with the
 *     user's answer.
 *
 * Pure side-effects (a spinner while a tool runs) are NOT this — use
 * `useOnToolStart` / `useOnToolEnd`, which observe the same command
 * fire-and-forget.
 *
 * @example
 * // Veto a destructive tool while the user hasn't unlocked "danger mode".
 * useGuardToolDispatch((input) =>
 *   input.name === "delete_all" && !unlocked ? "veto" : "proceed",
 * );
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 */

import type { DispatchInput, DispatchResult } from "@agentick/spec";
import {
  useCommandInterceptor,
  type GuardDecision,
  type GuardFn,
} from "./use-command-interceptor.js";

export type { GuardDecision };

export function useGuardToolDispatch(decide: GuardFn<DispatchInput, DispatchResult>): void {
  useCommandInterceptor(
    "tool:dispatch",
    "guard",
    // The public signature is fully typed to the `tool:dispatch` registry
    // row's spec types; the generic's escape-hatch overload takes the erased
    // form (compiler-react does not depend on the tool-executor package that
    // AUGMENTS the row, so `"tool:dispatch"` is not a literal key HERE — but
    // it IS the exact op the session forwards). At an adopter's app, calling
    // the generic directly is registry-derived and fully typed.
    decide as GuardFn<unknown, unknown>,
  );
}
