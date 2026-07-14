/**
 * ADR 87 — contribute `session.knobs` to the client `SessionHandle`.
 *
 * Importing `@agentick/knobs-next/client` both TYPES the slot (`declare module`)
 * and REGISTERS the runtime factory, so `client.session(id).knobs` self-assembles
 * — the client twin of the server's `bridges.knobs`. It's `knobsHandle`: the
 * `KnobsState` view plus `set(key, value)` over `knobs/set` (bidirectional).
 */

import { registerSessionHandleExtension } from "@agentick/client-next";
import { knobsHandle, type KnobsHandleView } from "./knobs-handle.js";

declare module "@agentick/spec-next" {
  interface SessionHandleExtensions {
    /** Live knobs view + `set(key, value)` for this session (`== knobsHandle(client, id)`). */
    readonly knobs: KnobsHandleView;
  }
}

registerSessionHandleExtension("knobs", (client, sessionId) => knobsHandle(client, sessionId));
