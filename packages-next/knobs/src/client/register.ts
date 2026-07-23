/**
 * ADR 87 — contribute `session.knobs` to the client `SessionHandle`.
 *
 * Importing `@agentick/knobs-next/client` both TYPES the slot (`declare module`)
 * and REGISTERS the runtime factory, so `client.session(id).knobs` self-assembles
 * — the client twin of the server's `bridges.knobs`. It's `knobsHandle`: the
 * `KnobsState` view plus `set(key, value)` over `knobs/set` (bidirectional).
 */

import { registerSessionHandleExtension } from "@agentick/client-core-next";
import { knobsHandle, type KnobsHandle } from "./knobs-handle.js";

declare module "@agentick/spec-next" {
  interface SessionHandleExtensions {
    /**
     * The knobs resource handle — the `ClientHandle` contract for this session:
     * `list()`/`get(id)` over knob descriptors+values (Enumerable), the zero-arg
     * `subscribe(cb)` store contract, and `set(id, value)` over `knobs/set`
     * (`== knobsHandle(client, id)`).
     */
    readonly knobs: KnobsHandle;
  }
}

registerSessionHandleExtension("knobs", (client, sessionId) => knobsHandle(client, sessionId));
