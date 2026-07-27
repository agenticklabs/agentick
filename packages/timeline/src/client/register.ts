/**
 * ADR 87 — contribute `session.timeline` to the client `SessionHandle`.
 *
 * Importing `@agentick/timeline/client` (which re-exports this) both TYPES
 * the slot (the `declare module` below) and REGISTERS the runtime factory, so
 * `client.session(id).timeline` self-assembles — the re-home of the free
 * `timelineView` factory as a first-class sub-handle. Client-core stays
 * agnostic; this is the harness's contribution.
 */

import { registerSessionHandleExtension } from "@agentick/client-core";
import { timelineHandle, type TimelineHandle } from "./timeline-handle.js";

declare module "@agentick/spec" {
  interface SessionHandleExtensions {
    /**
     * The timeline resource handle for this session — the `ClientHandle`
     * contract: `list()`/`get(id)` over the conversation window (Enumerable),
     * the zero-arg `subscribe(cb)` store contract, the window verbs
     * (`seed`/`prepend`/`append`/`clear`), and the grant-gated durable read —
     * `history({ fromSeq, limit })` for one page, `loadOlder()` for
     * cursor-tracking scroll-back (`== timelineHandle(client, id)`).
     */
    readonly timeline: TimelineHandle;
  }
}

registerSessionHandleExtension("timeline", (client, sessionId) =>
  timelineHandle(client, sessionId),
);
