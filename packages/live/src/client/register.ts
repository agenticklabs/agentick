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

// NO `wireMethods` — deliberate, and the one registered slot that declines the
// namespace fallthrough. The `live/*` rows are STREAM-addressed (`{ sessionId,
// streamId }`), and each open stream is already served by its own
// `LiveSessionHandle`, whose `stop()`/`abort()` issue the same rows AND run the
// local teardown that drops the stream from `active`. Exposing `live.stop(…)` on
// the FACET would let a caller end a stream behind the registry's back, leaving
// a dead handle enumerating as open — the bug #247 just fixed, through a second
// door. Reach a stream through `start()`'s handle, or through `active`.
//
// `SessionLive` is likewise the one sub-handle NOT on the unified `ClientHandle`
// contract: it has no `subscribe(cb)`, because a facet over N streams has no
// single state to notify about — the per-stream `onState`/`onTranscript`/`onFrame`
// callbacks are the change feeds, at the granularity that has one. `useHandle`
// therefore cannot bind `session.live`; bind a stream handle's callbacks
// instead. It does carry `close()` (the optional half of the contract) so
// `session.close()` can release every open stream.
registerSessionHandleExtension("live", (client, sessionId) => sessionLive(client, sessionId));
