/**
 * Dispatch provenance — maps the dispatch DOOR ({@link DispatchContext.via})
 * to the {@link OperationOrigin} stamped on the command's Operation at its
 * gate (ADR 51 §5/§6).
 *
 * A declared command stamps origin at the gate; the tool executor's public
 * `dispatch` method is that gate for in-process dispatches. The mapping is
 * the whole point of promoting `dispatch` to a command:
 *
 *   - `via: "model"`    → origin `"model"` — a model-originated tool call.
 *     Inside the process it is intentionally UNTRUSTED: the capability-policy
 *     subject (ADR 51 §5/§6). The loop executor's tool-call path dispatches
 *     with `via: "model"`, so every model-driven dispatch is journaled with
 *     `origin: "model"`.
 *   - `via: "dispatch"` → origin `"host"` — a direct in-process call by the
 *     host/session (e.g. `session.tools.dispatch(name, input)`), matching the
 *     `OperationOrigin` contract's "direct calls default `host`".
 *
 * The inbox/wire path does NOT go through this map: a `tool:dispatch` message
 * delivered over the inbox is stamped by its delivering gate (`msg.origin ??
 * "inbox"`) in `BaseHarness.invokeRegisteredCommand`, because origin names the
 * GATE the operation entered through, not the `via` the payload claims.
 *
 * @see docs/proposals/v2/blueprint/51-declared-commands.md
 */

import type { DispatchContext, OperationOrigin } from "@agentick/spec";

export function viaToOrigin(via: DispatchContext["via"]): OperationOrigin {
  return via === "model" ? "model" : "host";
}
