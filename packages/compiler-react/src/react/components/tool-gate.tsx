/**
 * `<ToolGate>` — the declarative confirm-dialog example (ADR 89 §4). A
 * component that GATES the model's tool calls behind a confirmation flow,
 * rendering nothing itself: it installs a {@link useGuardToolDispatch} guard
 * that, for the matched tool(s), awaits `confirm` and admits (`"proceed"`) or
 * denies (`"veto"`) the dispatch from the answer.
 *
 * This is the canonical "a React component defers a tool call to a human"
 * pattern — the guard suspends the dispatch IN-PATH on a bounded, abortable
 * confirmation (typically an elicitation), then resumes with the verdict. The
 * confirm flow is the ADOPTER's (capability, not opinion): `<ToolGate>` owns
 * the gate mechanism; you supply what "confirm" means (an elicitation, a
 * cached allow-list, a policy check).
 *
 * @example
 * // Confirm every destructive call via the session's elicitation.
 * function DangerGate() {
 *   const { elicitation } = useBridges();
 *   return (
 *     <ToolGate
 *       tool={(i) => i.name.startsWith("delete_")}
 *       confirm={async (input) => {
 *         const res = await elicitation.elicit({
 *           message: `Allow ${input.name}?`,
 *           schema: { type: "object", properties: {} },
 *         });
 *         return res.outcome === "accepted";
 *       }}
 *     />
 *   );
 * }
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 */

import type { DispatchInput } from "@agentick/spec";
import { useGuardToolDispatch } from "../hooks/use-guard-tool-dispatch.js";

export interface ToolGateProps {
  /**
   * Which tool call(s) this gate applies to — a tool name, a list of names,
   * or a predicate over the {@link DispatchInput}. Omit to gate EVERY tool.
   */
  readonly tool?: string | readonly string[] | ((input: DispatchInput) => boolean);
  /**
   * The confirmation flow — awaited IN-PATH before the tool runs. Return
   * `true` to admit the dispatch, `false` to veto it. Typically drives
   * `useBridges().elicitation` (a bounded, abortable ask), but any prompt
   * decision works. Must be prompt or bounded — it sits in the tool call's
   * critical path.
   */
  readonly confirm: (input: DispatchInput) => boolean | Promise<boolean>;
}

export function ToolGate({ tool, confirm }: ToolGateProps): null {
  useGuardToolDispatch(async (input) => {
    if (!toolMatches(tool, input)) return "proceed";
    return (await confirm(input)) ? "proceed" : "veto";
  });
  return null;
}
ToolGate.displayName = "ToolGate";

function toolMatches(tool: ToolGateProps["tool"], input: DispatchInput): boolean {
  if (tool === undefined) return true;
  if (typeof tool === "function") return tool(input);
  if (Array.isArray(tool)) return tool.includes(input.name);
  return input.name === tool;
}
