/**
 * `@agentick/timeline-next/client` — the client-side projection of a session's
 * timeline.
 *
 * The far side of the timeline append stream: a reactive view an app frontend
 * subscribes to. Depends on `@agentick/client-core-next` (the generic
 * `eventView`) — NOT on the timeline harness runtime. Mirrors the `/react`
 * subpath convention: a harness package may add a `/client` surface that
 * depends on the generic client without pulling the server harness into a
 * browser bundle.
 *
 * The client timeline is `fold(session event stream)`, seeded with
 * server-hydrated `initial` (LogStore.history) and tailing live via
 * `fromCursor` — no read RPC, no bespoke channel.
 */

export {
  timelineView,
  type TimelineClient,
  type TimelineView,
  type TimelineViewOptions,
} from "./timeline-view.js";
