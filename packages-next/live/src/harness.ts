/**
 * LiveHarness — the v0 minimal core of a live media session (ADR 88).
 *
 * A stream registry keyed by `streamId` within this harness's session
 * `(scopeId)`, plus routing + cleanup. Deliberately NOT an engine: it ships the
 * pipes (`(sessionId, streamId)` → `onStream` context, uplink fan-in, downlink
 * fan-out, transcript/state control channels, interrupt signal) and stops
 * there. STT/TTS/turn-detection/barge-in are composed by the adopter from
 * existing primitives (`session.send`, `guard`, steering, tasks) — the whole
 * engine layer (`pipelineEngine`, `TurnArbiter`, `RealtimeModel`) is an ADR 88
 * Future direction, not built here.
 *
 * `live` is an OPTIONAL extension (like sandbox / mcp), NOT a bundled built-in —
 * `withLive` constructs ONE per session against the installer substrate and
 * registers it under the `"live"` namespace, so `bridges.live` / `session.live`
 * resolve to the same instance.
 *
 * @see docs/proposals/v2/blueprint/88-live-media-sessions.md
 */

import { Effect } from "effect";
import { BaseHarness, ulid, type Middleware } from "@agentick/runtime-next";
import type {
  EventBus,
  LiveHarnessProtocol,
  LiveState,
  LiveStream,
  MessageEnvelope,
  MessageHandlerError,
  MediaFrame,
  MediaSessionRef,
  MessageInbox,
  OperationJournal,
  SessionHarnessProtocol,
  TranscriptDelta,
  Unsubscribe,
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";

import {
  LIVE_STATE_CHANNEL,
  LIVE_TRANSCRIPT_CHANNEL,
  type LiveStateFrame,
  type LiveTranscriptFrame,
} from "./channel.js";

// ============================================================================
// Options
// ============================================================================

export interface LiveHarnessOptions {
  /**
   * The per-stream birth hook — invoked with a fresh {@link LiveStream} each
   * time a new `(sessionId, streamId)` opens (`start`). Where the app wires its
   * STT/TTS and turn glue. Omitted on a bare harness (routing still works;
   * nobody observes uplink).
   */
  readonly onStream?: (stream: LiveStream) => void;
  /**
   * Resolver for the owning session, surfaced on {@link LiveStream.session}.
   * A THUNK because the session is not yet registered at `withLive` install
   * time (it resolves at stream birth, which is post-registration). Throws on
   * `stream.session` access when it resolves `undefined`.
   */
  readonly session?: () => SessionHarnessProtocol | undefined;
  /**
   * The DOWNLINK sink — where `stream.sendFrame(frame)` delivers server→client
   * frames. Injected by the media-transport server half (the deferred
   * `@agentick/transport-ws-media-next`). Omitted in v0 core → downlink frames
   * are dropped (documented; a test injects a recorder).
   */
  readonly downlinkSink?: (ref: MediaSessionRef, frame: MediaFrame) => void | Promise<void>;
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  readonly interceptorParent?: BaseHarness;
}

// ============================================================================
// Per-stream runtime state
// ============================================================================

interface StreamState {
  readonly ref: MediaSessionRef;
  readonly frameListeners: Set<(f: MediaFrame) => void>;
  readonly interruptListeners: Set<(playedMs?: number) => void>;
  readonly closeListeners: Set<() => void>;
  closed: boolean;
}

// ============================================================================
// Harness
// ============================================================================

export class LiveHarness extends BaseHarness<"live"> implements LiveHarnessProtocol {
  private readonly streams = new Map<string, StreamState>();
  private readonly onStreamCb: LiveHarnessOptions["onStream"];
  private readonly resolveSession: LiveHarnessOptions["session"];
  private readonly downlinkSink: LiveHarnessOptions["downlinkSink"];

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: LiveHarnessOptions = {},
  ) {
    super("live", scopeId, journal, bus, inbox, {
      inheritedInterceptors: options.inheritedInterceptors,
      interceptorParent: options.interceptorParent,
    });
    this.onStreamCb = options.onStream;
    this.resolveSession = options.session;
    this.downlinkSink = options.downlinkSink;
  }

  // ─────────── start ───────────

  start(streamId?: string): MediaSessionRef {
    const sid = streamId ?? `live:${ulid()}`;
    const ref: MediaSessionRef = { sessionId: this.scopeId, streamId: sid };
    const existing = this.streams.get(sid);
    if (existing && !existing.closed) return ref; // idempotent per streamId

    const state: StreamState = {
      ref,
      frameListeners: new Set(),
      interruptListeners: new Set(),
      closeListeners: new Set(),
      closed: false,
    };
    this.streams.set(sid, state);
    this.emitState(sid, "listening");
    this.onStreamCb?.(this.makeStream(state));
    return ref;
  }

  // ─────────── routing ───────────

  push(ref: MediaSessionRef, frame: MediaFrame): void {
    const state = this.streams.get(ref.streamId);
    if (!state || state.closed) return;
    for (const cb of state.frameListeners) cb(frame);
  }

  interrupt(streamId: string, playedMs?: number): void {
    const state = this.streams.get(streamId);
    if (!state || state.closed) return;
    for (const cb of state.interruptListeners) cb(playedMs);
  }

  async stop(
    streamId: string,
    opts?: { readonly hard?: boolean; readonly reason?: string },
  ): Promise<void> {
    const state = this.streams.get(streamId);
    if (!state || state.closed) return; // idempotent
    state.closed = true;
    this.streams.delete(streamId);
    this.emitState(streamId, "closed");
    for (const cb of state.closeListeners) cb();
    // Close the downlink half (deferred transport half is a no-op in v0 core).
    void opts; // `hard` vs graceful only differs at the transport half (deferred).
  }

  // ─────────── close ───────────

  override async close(): Promise<void> {
    const ids = [...this.streams.keys()];
    for (const id of ids) await this.stop(id, { hard: true, reason: "harness_closed" });
    await super.close();
  }

  // ─────────── inbox (no live message types in v0) ───────────

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({ cause: `Unknown live message type: ${String(msg.type)}` }),
    );
  }

  // ─────────── LiveStream construction ───────────

  private makeStream(state: StreamState): LiveStream {
    const ref = state.ref;
    const harness = this;
    const stream: LiveStream = {
      ref,
      get session(): SessionHarnessProtocol {
        return harness.resolveSessionOrThrow();
      },
      onFrame: (cb) => this.addFrameListener(state, cb),
      uplink: this.makeUplink(state),
      sendFrame: (frame) => this.sendDownlink(ref, frame),
      downlink: this.makeDownlink(ref),
      emitTranscript: (t) => this.emitTranscript(ref.streamId, t),
      emitState: (s) => this.emitState(ref.streamId, s),
      onInterrupt: (cb) => this.addInterruptListener(state, cb),
    };
    return stream;
  }

  private resolveSessionOrThrow(): SessionHarnessProtocol {
    const session = this.resolveSession?.();
    if (session === undefined) {
      throw new Error(
        "LiveStream.session is unavailable: no session resolver was provided (or it resolved undefined). withLive wires `() => app.getSession(sessionId)`.",
      );
    }
    return session;
  }

  private addFrameListener(state: StreamState, cb: (f: MediaFrame) => void): Unsubscribe {
    state.frameListeners.add(cb);
    return () => {
      state.frameListeners.delete(cb);
    };
  }

  private addInterruptListener(state: StreamState, cb: (playedMs?: number) => void): Unsubscribe {
    state.interruptListeners.add(cb);
    return () => {
      state.interruptListeners.delete(cb);
    };
  }

  private makeUplink(state: StreamState): ReadableStream<MediaFrame> {
    return new ReadableStream<MediaFrame>({
      start: (controller) => {
        const off = this.addFrameListener(state, (f) => controller.enqueue(f));
        state.closeListeners.add(() => {
          off();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });
  }

  private makeDownlink(ref: MediaSessionRef): WritableStream<MediaFrame> {
    return new WritableStream<MediaFrame>({
      write: (frame) => this.sendDownlink(ref, frame),
    });
  }

  private async sendDownlink(ref: MediaSessionRef, frame: MediaFrame): Promise<void> {
    await this.downlinkSink?.(ref, frame);
  }

  // ─────────── control-plane channels ───────────

  emitTranscript(streamId: string, t: TranscriptDelta): void {
    const frame: LiveTranscriptFrame = { streamId, transcript: t };
    this.publishOnChannel(LIVE_TRANSCRIPT_CHANNEL, frame);
  }

  emitState(streamId: string, s: LiveState): void {
    const frame: LiveStateFrame = { streamId, state: s };
    this.publishOnChannel(LIVE_STATE_CHANNEL, frame);
  }

  private publishOnChannel(channel: string, payload: unknown): void {
    void Effect.runPromise(
      this.bus.append({
        id: ulid(),
        surface: "session",
        name: `session:channel:${channel}`,
        phase: "delta",
        timestamp: Date.now(),
        scope: { sessionId: this.scopeId },
        payload,
      } as Parameters<typeof this.bus.append>[0]),
    ).catch(() => undefined);
  }
}
