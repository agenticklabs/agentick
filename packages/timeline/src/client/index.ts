/**
 * `@agentick/timeline/client` — the client-side projection of a session's
 * timeline.
 *
 * The far side of the timeline append stream: a reactive view an app frontend
 * subscribes to. Depends on `@agentick/client-core` (the generic
 * `eventView`) — NOT on the timeline harness runtime. Mirrors the `/react`
 * subpath convention: a harness package may add a `/client` surface that
 * depends on the generic client without pulling the server harness into a
 * browser bundle.
 *
 * The client timeline is `fold(session event stream)`, seeded with
 * server-hydrated `initial` (LogStore.history) and tailing live via
 * `fromCursor`. `session.timeline` (the sub-handle) adds a cursored durable read
 * over the grant-gated `timeline/history` command — `history()` for one page,
 * `loadOlder()` for cursor-tracking scroll-back.
 *
 * Importing this subpath contributes the `client.session(id).timeline` property
 * (a `TimelineHandle`) to the client `SessionHandle` (ADR 87). The free
 * `timelineView` factory remains exported as the handle's implementation, for
 * the headless/composition case.
 */

// Type-only side effect: makes `timeline/history` a valid `WireMethods` row for
// the handle's `transport.request` call, WITHOUT loading the server-bridge
// augmentations (`../augment.js` pulls the runtime slot registration).
import "../wire-augment.js";

export type { TimelineHistoryInput, TimelineHistoryPage } from "../wire-augment.js";
export {
  timelineView,
  type TimelineClient,
  type TimelineView,
  type TimelineViewOptions,
} from "./timeline-view.js";
export {
  timelineHandle,
  type TimelineHandle,
  type TimelineCommandClient,
  type LoadOlderResult,
} from "./timeline-handle.js";

// Side-effect: contribute `session.timeline` to the client SessionHandle (ADR 87).
import "./register.js";
