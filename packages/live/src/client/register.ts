/**
 * ADR 87 — contribute `session.live` to the client `SessionHandle`.
 *
 * Importing `@agentick/live/client` (which re-exports this) both TYPES the
 * slot (the `declare module` below) and REGISTERS the runtime factory, so
 * `client.session(id).live` self-assembles — the client twin of the server's
 * `bridges.live`. Client-core stays agnostic; this is the harness's
 * contribution. The slot is OPTIONAL (`?`) because `live` is an optional
 * extension — a build that never imports `/client` never sees it.
 */

import { registerSessionHandleExtension } from "@agentick/client-core";
import { sessionLive, type SessionLive } from "./session-live.js";

declare module "@agentick/spec" {
  interface SessionHandleExtensions {
    /**
     * The live media facet for this session — `start()` opens a stream and
     * returns a `LiveSessionHandle`; `active` lists open handles
     * (`== sessionLive(client, id)`).
     */
    readonly live: SessionLive;
  }
}

registerSessionHandleExtension("live", (client, sessionId) => sessionLive(client, sessionId));
