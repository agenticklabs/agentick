/**
 * @agentick/live — LiveHarness (ADR 88).
 *
 * The real-time media plane: stream mic audio / video frames UP over a
 * session-scoped `MediaSession` keyed by `(sessionId, streamId)` and media
 * DOWN, with a `MediaTransport` capability, stream routing, and the
 * `session.live` client handle. v0 ships the PIPES (transport contract + handle
 * + routing + `live/*` wire + `onStream` hook); the STT/TTS engine,
 * `TurnArbiter`, and realtime-provider integration are ADR 88 Future directions
 * the adopter composes from existing primitives (`session.send`, `guard`,
 * steering, tasks).
 *
 * OPTIONAL extension — installed separately, NOT bundled into the `agentick`
 * metapackage.
 *
 * @see docs/proposals/v2/blueprint/88-live-media-sessions.md
 */

// Side-effect import — registers the `bridges.live` + `session.live` slots on
// the spec via TypeScript module augmentation. Per ADR 27, every harness
// package owns its own slot declaration.
import "./augment.js";

export { LiveHarness, type LiveHarnessOptions } from "./harness.js";
export {
  withLive,
  EXTENSION_NAME as LIVE_EXTENSION_NAME,
  type WithLiveOptions,
} from "./extension.js";
export { liveWireExtension } from "./wire.js";
export {
  LIVE_TRANSCRIPT_CHANNEL,
  LIVE_STATE_CHANNEL,
  LIVE_TRANSCRIPT_CHANNEL_FQN,
  LIVE_STATE_CHANNEL_FQN,
  type LiveTranscriptChannelName,
  type LiveStateChannelName,
  type LiveTranscriptFrame,
  type LiveStateFrame,
} from "./channel.js";

// Re-export the spec contracts from the same package as the impl, so adopters
// get the protocol + reference from one dep (mirrors tasks re-exporting its
// ports).
export type {
  Live,
  LiveHarnessProtocol,
  LiveState,
  LiveStream,
  LiveSessionHandle,
  MediaDownlink,
  MediaEnvelope,
  MediaFrame,
  MediaSessionRef,
  MediaTransport,
  MediaUplink,
  TranscriptDelta,
} from "@agentick/spec";
