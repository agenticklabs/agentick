/**
 * ADR 87 — contribute `session.gates` to the client `SessionHandle`.
 *
 * Importing `@agentick/gates/client` both TYPES the slot (`declare module`)
 * and REGISTERS the runtime factory, so `client.session(id).gates`
 * self-assembles — the client twin of the server's `bridges.gates`. It's
 * `gatesHandle`: the {@link GateInfo} snapshot view (`list`/`get`) plus the
 * `clear`/`defer`/`override` wire verbs, RPC-backed (no `gates-state` channel
 * yet — see {@link gatesHandle}).
 */

import { registerSessionHandleExtension } from "@agentick/client-core";
import type { WireNamespaceMethods } from "@agentick/spec";
import { gatesHandle, type GatesClientHandle } from "./gates-handle.js";

declare module "@agentick/spec" {
  interface SessionHandleExtensions {
    /**
     * The gates resource handle — the `ClientHandle` contract for this session:
     * `list()`/`get(name)` over the gate snapshot (Enumerable), the zero-arg
     * `subscribe(cb)` store contract, and `clear`/`defer`/`override` over the
     * `gates/*` wire commands (`== gatesHandle(client, id)`).
     */
    readonly gates: GatesClientHandle;
  }
}

// The namespace's wire rows, so the ones this handle does NOT implement stay
// reachable (`session.gates.commands(…)`). Rows the handle DOES implement stay
// shadowed by it — precedence lives in `wireFallthrough`, not in this list.
registerSessionHandleExtension("gates", (client, sessionId) => gatesHandle(client, sessionId), {
  wireMethods: [
    "clear",
    "commands",
    "defer",
    "list",
    "override",
  ] satisfies readonly (keyof WireNamespaceMethods<"gates">)[],
});
