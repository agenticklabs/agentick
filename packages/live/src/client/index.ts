/**
 * `@agentick/live/client` — the client-side projection of a live session.
 *
 * The far side of the live planes: the `session.live` facet + `LiveSessionHandle`
 * a browser (or headless server-to-server client) drives. Depends on
 * `@agentick/client-core` (the generic `channelView`) — NOT on the live
 * harness runtime — so importing it into a browser bundle pulls no server code.
 * Mirrors the tasks `/client` convention.
 */

// Type-only side effect: makes `live/*` valid `WireMethods` rows for the
// handle's `transport.request("live/start", …)` — no server code.
import "../wire-augment.js";

export {
  liveSessionHandle,
  type LiveCommandClient,
  type LiveSessionHandleDeps,
  type RuntimeLiveSessionHandle,
} from "./live-session-handle.js";
export { sessionLive, type SessionLive, type LiveFacetClient } from "./session-live.js";

// The control-plane channel names + frame shapes, nameable from `/client` so a
// browser bundle that subscribes or folds frames itself does NOT have to import
// the ROOT barrel (which drags the live harness runtime in). `channel.ts` is
// constants + types only.
export {
  LIVE_STATE_CHANNEL,
  LIVE_STATE_CHANNEL_FQN,
  LIVE_TRANSCRIPT_CHANNEL,
  LIVE_TRANSCRIPT_CHANNEL_FQN,
  type LiveStateChannelName,
  type LiveStateFrame,
  type LiveTranscriptChannelName,
  type LiveTranscriptFrame,
} from "../channel.js";

// Side-effect: contribute `session.live` to the client SessionHandle (ADR 87).
import "./register.js";
