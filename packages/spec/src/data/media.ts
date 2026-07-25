/**
 * Live media plane primitives (ADR 88) — the opaque framed-media contracts
 * shared by the `@agentick/live` server harness and its `/client`
 * projection.
 *
 * These are DATA shapes (wire-serializable, browser-safe, zero runtime deps) —
 * they live in `data/` alongside the other cross-boundary payloads (content
 * blocks, channels). The harness PROTOCOL (`LiveHarnessProtocol`, `LiveStream`)
 * lives in `../protocol/live-harness.ts`; the client HANDLE
 * (`LiveSessionHandle`) lives in `../client/live.ts` — the same protocol /
 * client / data split `tasks` uses.
 *
 * ## The two planes (ADR 88 §Two planes)
 *
 * - **Control/event plane** rides the existing wire: `live/start` / `live/stop`
 *   / `live/interrupt` are ADR 46 wire methods; transcripts + state ride ADR 33
 *   channels.
 * - **Media plane** is this primitive: opaque framed media keyed by
 *   `(sessionId, streamId)`. It is a CAPABILITY a transport optionally
 *   implements ({@link MediaTransport}), NOT a method on the core
 *   `ClientTransport` (which the whole system shares). Feature-detected via
 *   {@link import("../client/transport.js").TransportCapabilities.media}.
 *
 * @see docs/proposals/v2/blueprint/88-live-media-sessions.md
 */

// ============================================================================
// MediaSession identity
// ============================================================================

/**
 * The correlation key of a single continuous media stream. `sessionId` binds to
 * the agentick conversation; `streamId` scopes ONE continuous media stream
 * within it (mic uplink + screen-share video = two `streamId`s on one
 * `sessionId`). The id lets the media plane be a sidecar the control plane never
 * has to carry (ADR 88 §Two planes).
 */
export interface MediaSessionRef {
  readonly sessionId: string;
  readonly streamId: string;
}

// ============================================================================
// MediaFrame — general (NOT audio-specific) opaque media
// ============================================================================

/**
 * One opaque media frame. General media — audio / video / image / screen all
 * ride the same {@link MediaSessionRef}; `kind` discriminates and the open
 * `(string & {})` arm keeps it extensible without a spec bump.
 */
export interface MediaFrame {
  readonly kind: "audio" | "video" | "image" | (string & {});
  readonly envelope: MediaEnvelope;
  readonly payload: Uint8Array;
}

/**
 * Per-frame metadata. The `format` + `sampleRate` are carried (never hardcoded)
 * so a downstream STT/decoder reads the rate off the frame; `timestamp` + `seq`
 * order the stream.
 */
export interface MediaEnvelope {
  /** MIME-ish media type: `"audio/pcm"` | `"audio/pcmu"` | `"image/jpeg"` | … */
  readonly format: string;
  /** Sampling rate (Hz) — NEVER hardcode a rate; carry it. Audio-only. */
  readonly sampleRate?: number;
  /** Channel count. Audio-only. */
  readonly channels?: number;
  /** ms, monotonic within the session. */
  readonly timestamp: number;
  /** Ordering sequence within the stream. */
  readonly seq: number;
}

// ============================================================================
// Live state + transcripts (control/event plane payloads)
// ============================================================================

/**
 * The conversational state of a live session, projected to the client on the
 * state channel and surfaced as {@link import("../client/live.js").LiveSessionHandle.status}.
 * `closed` is terminal — the stream ended (`stop` / `abort` / disconnect).
 */
export type LiveState = "idle" | "listening" | "thinking" | "speaking" | "closed";

/**
 * One transcript delta emitted on the control channel — interim OR final. Grain
 * matches the common denominator of streaming STT providers (Google, Deepgram):
 * a `role` (`"user"` for recognized speech, `"assistant"` for the model reply
 * echoed back), the current `text`, and whether it is `final` (utterance
 * complete) vs interim (still being refined).
 */
export interface TranscriptDelta {
  readonly role: "user" | "assistant" | (string & {});
  readonly text: string;
  readonly final: boolean;
}

// ============================================================================
// MediaTransport — the media-plane capability (ADR 88 §Two planes)
// ============================================================================

/**
 * The media-plane capability a transport OPTIONALLY implements (feature-detected
 * via `TransportCapabilities.media`). In-band transports (WebSocket) implement
 * it with binary frames on the control socket (a native capability of
 * `@agentick/transport-websocket`, NOT a separate package — Future direction);
 * out-of-band transports (WebRTC) negotiate a media track and hand back an opaque
 * sink/source (those DO warrant their own package). v0 ships the contract + the
 * in-process `inProcessLiveMedia`.
 *
 * Verbatim from ADR 88 §Two planes.
 */
export interface MediaTransport {
  /** Open the client→server media stream for `ref`. */
  openUplink(ref: MediaSessionRef): MediaUplink;
  /** Open the server→client media stream for `ref`. */
  openDownlink(ref: MediaSessionRef): MediaDownlink;
}

/**
 * The client→server half. `send` push is backpressured: AWAITING it IS the
 * backpressure signal (Knowify's Google `write(): boolean` + pause) — the
 * `WritableStream` projection maps it to the writer's `ready`.
 */
export interface MediaUplink {
  /** Push one frame. Awaiting the returned promise = backpressure. */
  send(frame: MediaFrame): Promise<void>;
  /** Close the uplink. */
  close(reason?: string): Promise<void>;
}

/**
 * The server→client half. The client RECEIVES downlink (asymmetric by
 * direction — there is no client-side downlink *send*), so the observe surface
 * is `onFrame`; the `ReadableStream` projection enqueues from it. (ADR 88 §Two
 * planes shows {@link MediaUplink} verbatim and leaves the downlink mirror to be
 * spelled out here.)
 */
export interface MediaDownlink {
  /** Observe frames arriving from the server. Returns an unsubscribe. */
  onFrame(cb: (frame: MediaFrame) => void): () => void;
  /** Close the downlink. */
  close(reason?: string): Promise<void>;
}
