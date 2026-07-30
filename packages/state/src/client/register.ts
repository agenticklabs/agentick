/**
 * ADR 87 — contribute `session.state` to the client `SessionHandle`.
 *
 * Importing `@agentick/state/client` both TYPES the slot (`declare module`)
 * and REGISTERS the runtime factory, so `client.session(id).state`
 * self-assembles — the client twin of the server's `session.state`. It's
 * `stateHandle`: the {@link StateListEntry} snapshot view (`list`/`get`) plus
 * the `set`/`delete` wire verbs, RPC-backed (no `state-state` channel — see
 * {@link stateHandle}).
 */

import { registerSessionHandleExtension } from "@agentick/client-core";
import type { WireNamespaceMethods } from "@agentick/spec";
import { stateHandle, type StateClientHandle } from "./state-handle.js";

declare module "@agentick/spec" {
  interface SessionHandleExtensions {
    /**
     * The state resource handle — the `ClientHandle` contract for this session:
     * `list()`/`get(key)` over the state snapshot (Enumerable), the zero-arg
     * `subscribe(cb)` store contract, and `set`/`delete` over the `state/*`
     * wire commands (`== stateHandle(client, id)`).
     */
    readonly state: StateClientHandle;
  }
}

// The namespace's wire rows. TODAY the handle implements all four, so all four
// stay SHADOWED — `state.get(key)` is the sync snapshot read, never the async
// `state/get` row. Declaring the set anyway is the point: a row added to
// `state/*` tomorrow is reachable through `session.state.<row>(…)` with no client
// change, and the `satisfies` makes a removed row a compile error here.
registerSessionHandleExtension("state", (client, sessionId) => stateHandle(client, sessionId), {
  wireMethods: [
    "delete",
    "get",
    "list",
    "set",
  ] satisfies readonly (keyof WireNamespaceMethods<"state">)[],
});
