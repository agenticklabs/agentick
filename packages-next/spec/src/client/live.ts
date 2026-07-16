/**
 * `LiveSessionHandle` — the PORTABLE client surface of a live media session
 * (ADR 88). Spec-level: imperative + callback, Node === browser (NO
 * stream-type dependency here — the `WritableStream`/`ReadableStream`
 * `uplink`/`downlink` faces are first-class RUNTIME projections that live in
 * `@agentick/live-next/client`, built over this surface).
 *
 * Reached as `session.live.start()` (the `session.live` facet contributed by
 * `@agentick/live-next/client`). Auto-bound to `(sessionId, streamId)` — the
 * caller never threads ids again. Asymmetric by direction: the client SENDS
 * uplink (`sendFrame`) and RECEIVES downlink (`onFrame`).
 *
 * @see docs/proposals/v2/blueprint/88-live-media-sessions.md
 */

import type { Unsubscribe } from "../protocol/inbox.js";
import type { LiveState, MediaFrame, MediaSessionRef, TranscriptDelta } from "../data/media.js";

export interface LiveSessionHandle {
  /** `{ sessionId, streamId }` — auto-bound at `start()`. */
  readonly ref: MediaSessionRef;
  /** Last-known conversational state (folded from the state channel). */
  readonly status: LiveState;

  /** UPLINK push. Awaiting the returned promise = backpressure. */
  sendFrame(frame: MediaFrame): Promise<void>;
  /** DOWNLINK observe (the client RECEIVES). Returns an unsubscribe. */
  onFrame(cb: (frame: MediaFrame) => void): Unsubscribe;
  /** Observe transcript deltas (interim + final) on the control channel. */
  onTranscript(cb: (t: TranscriptDelta) => void): Unsubscribe;
  /** Observe conversational-state transitions on the control channel. */
  onState(cb: (s: LiveState) => void): Unsubscribe;

  /**
   * Manual barge-in signal, carrying the played-audio offset (ms) the client
   * alone knows. Keeps the stream OPEN (within-stream), unlike stop/abort.
   * Barge-in policy is app-composed on the server (`onInterrupt`).
   */
  interrupt(playedMs?: number): Promise<void>;
  /** Graceful end of the continuous stream. */
  stop(): Promise<void>;
  /** Hard kill. */
  abort(reason?: string): Promise<void>;
}
