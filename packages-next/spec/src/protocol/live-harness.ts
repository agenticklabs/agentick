/**
 * LiveHarnessProtocol — the server surface of a live media session (ADR 88).
 *
 * The v0 core is **stream routing + a per-stream hook**, nothing more — no
 * engine, no arbiter (those are ADR 88 Future directions). A frame tagged
 * `(sessionId, streamId)` is routed to the right per-stream {@link LiveStream}
 * context; the app wires STT/TTS/turn-detection/barge-in from existing
 * primitives (`session.send`, `guard`, steering, tasks).
 *
 * Concrete impl: `LiveHarness` in `@agentick/live-next`, extending
 * `BaseHarness<"live">`. `live` is an OPTIONAL extension (like sandbox / mcp),
 * NOT a bundled built-in — installed separately and self-constructed by
 * `withLive`.
 *
 * @see docs/proposals/v2/blueprint/88-live-media-sessions.md
 */

import type { Unsubscribe } from "./inbox.js";
import type { SessionHarnessProtocol } from "./session-harness.js";
import type { LiveState, MediaFrame, MediaSessionRef, TranscriptDelta } from "../data/media.js";

// ============================================================================
// LiveStream — the per-stream server context (mirror of the client handle)
// ============================================================================

/**
 * The server-side context for ONE continuous media stream — handed to
 * {@link import("./app-extension.js")}'s `withLive({ onStream })` callback at
 * stream birth. The mirror of the client {@link import("../client/live.js").LiveSessionHandle},
 * asymmetric by direction: the server RECEIVES uplink and SENDS downlink.
 *
 * The media surface is imperative (`onFrame` / `sendFrame`) + stream projection
 * (`uplink` / `downlink`) — the same callback-is-spec, streams-are-projection
 * duality as the client. `emitTranscript` / `emitState` push control-plane
 * events down the channel to the client's `onTranscript` / `onState`.
 */
export interface LiveStream {
  readonly ref: MediaSessionRef;
  /**
   * The owning session — the EXISTING primitive the app triggers a turn with
   * (`stream.session.send({ messages })`), reads the timeline from, dispatches
   * tools on. The framework contributes the pipe; the conversation is ordinary
   * agentick.
   */
  readonly session: SessionHarnessProtocol;

  /** UPLINK observe (server receives client frames). Returns an unsubscribe. */
  onFrame(cb: (frame: MediaFrame) => void): Unsubscribe;
  /** UPLINK projection — a `ReadableStream` that enqueues each uplink frame. */
  readonly uplink: ReadableStream<MediaFrame>;

  /** DOWNLINK push (server sends a frame to the client). */
  sendFrame(frame: MediaFrame): Promise<void>;
  /** DOWNLINK projection — a `WritableStream` whose `write` calls {@link sendFrame}. */
  readonly downlink: WritableStream<MediaFrame>;

  /** Emit a transcript delta on the control channel → client `onTranscript`. */
  emitTranscript(t: TranscriptDelta): void;
  /** Emit a state transition on the control channel → client `onState`. */
  emitState(s: LiveState): void;

  /**
   * Observe client interrupt (barge-in) signals on this stream — the
   * server-side landing of the client's `interrupt(playedMs?)`. Barge-in itself
   * is NOT framework logic (ADR 88): the app composes it here from existing
   * primitives (`execution.abort()` + steering `send`), reading the exact
   * played-audio offset the client alone knows. Returns an unsubscribe.
   */
  onInterrupt(cb: (playedMs?: number) => void): Unsubscribe;
}

// ============================================================================
// LiveHarnessProtocol
// ============================================================================

/**
 * The session-scoped live harness — a stream registry keyed by `streamId`
 * within the harness's `(sessionId)`, plus routing + cleanup. Reached on the
 * server as `session.live` (the `SessionHarnessProtocol.live` slot augmented by
 * `@agentick/live-next`) and driven by the `live/*` wire methods.
 */
export interface LiveHarnessProtocol {
  readonly id: string;

  /**
   * Open a new continuous media stream (mints the `streamId` when omitted),
   * register it, and fire the `onStream` hook. Idempotent per `streamId`.
   * Returns the auto-bound {@link MediaSessionRef}. Driven by `live/start`.
   */
  start(streamId?: string): MediaSessionRef;

  /**
   * Route an inbound UPLINK frame to its stream's `onFrame` observers. Called by
   * the media-transport server half (`@agentick/transport-ws-media-next`, or the
   * in-process `inProcessLiveMedia`) when a client frame arrives; a no-op for an
   * unknown / closed stream.
   */
  push(ref: MediaSessionRef, frame: MediaFrame): void;

  /**
   * Observe DOWNLINK frames the harness emits (from `stream.sendFrame`) — the
   * egress mirror of {@link push}. The media-transport server half subscribes
   * here to forward server→client frames down the wire. Fans out to every
   * observer; returns an unsubscribe. (The constructor `downlinkSink` option is
   * the single-sink convenience; this is the runtime-attachable seam.)
   */
  onDownlink(cb: (ref: MediaSessionRef, frame: MediaFrame) => void): Unsubscribe;

  /**
   * Deliver a client interrupt (barge-in) signal to the stream's `onInterrupt`
   * observers, carrying the played-audio offset. Driven by `live/interrupt`.
   * A no-op for an unknown stream.
   */
  interrupt(streamId: string, playedMs?: number): void;

  /**
   * End a stream — `hard: false` (default) graceful, `hard: true` a hard kill.
   * Drops it from the registry, emits `closed` state, and closes its transport
   * half. Idempotent. Driven by `live/stop`.
   */
  stop(
    streamId: string,
    opts?: { readonly hard?: boolean; readonly reason?: string },
  ): Promise<void>;

  /** Tear down every open stream and the harness. Idempotent. */
  close(): Promise<void>;
}

/**
 * Adopter-facing alias for the live protocol (ADR 42 — the `Harness`-word stays
 * out of public surfaces). Structurally identical to
 * {@link LiveHarnessProtocol}.
 */
export type Live = LiveHarnessProtocol;
