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

registerSessionHandleExtension("state", (client, sessionId) => stateHandle(client, sessionId));
