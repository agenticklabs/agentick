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
import { BaseHarness, runHarnessProtocol, ulid, type Middleware } from "@agentick/runtime";
import { mergeLayered, omitUndefined } from "@agentick/utils";
import type {
  EventBus,
  JournalingPolicy,
  LiveHarnessProtocol,
  LiveState,
  LiveStream,
  MessageEnvelope,
  MessageHandlerError,
  MediaFrame,
  MediaSessionRef,
  MessageInbox,
  Operation,
  OperationJournal,
  SessionHarnessProtocol,
  TranscriptDelta,
  Unsubscribe,
} from "@agentick/spec";
import { DEFAULT_JOURNALING_POLICY, HandlerError } from "@agentick/spec";

// The `EventScopeExtensions.streamId` augmentation this file's operation
// scopes depend on. Imported HERE, not only from the barrel, so a consumer that
// reaches this module directly still compiles.
import "./augment.js";
import {
  LIVE_STATE_CHANNEL,
  LIVE_TRANSCRIPT_CHANNEL,
  type LiveStateFrame,
  type LiveTranscriptFrame,
} from "./channel.js";

// ============================================================================
// Command lifecycle hooks (ADR 80/83) — typed CommandRegistry augmentation.
// ============================================================================
//
// ADR 92 Family 2 §6 — the in-process teardown verbs are operations. The wire
// ingress path (`live/*` JSON-RPC) was already enveloped by ADR 90; a direct
// `session.live.stop(...)` from a tool handler or a turn-arbiter was not, so a
// guard could veto a remote hangup but not a local one. That asymmetry is what
// these two declarations close.
//
// The registry key is the canonical `live:<verb>` form (the `:command:` infix
// `deriveHookNames` strips), so `live:stop` mints `onBeforeLiveStop` /
// `onAfterLiveStop`.
//
// `start` is ABSENT on purpose — it returns a `MediaSessionRef` SYNCHRONOUSLY,
// and a sync return cannot host the async interceptor fold. See the
// `TODO(ADR-92 family-3)` at `start` below.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "live:stop": { input: LiveStopInput; output: void };
    "live:close": { input: LiveCloseInput; output: void };
  }
}

/** Operation input for `live:command:stop` — the wire `live/stop` params shape. */
export interface LiveStopInput {
  readonly streamId: string;
  /** Forced teardown (skip the graceful drain at the transport half). */
  readonly hard?: boolean;
  /** Adopter-supplied teardown reason, carried into the audit record. */
  readonly reason?: string;
}

/**
 * Operation input for `live:command:close` — harness-wide teardown. Empty
 * today; the streams it tears down are journaled by the nested
 * `live:command:stop` records it produces (layered execution = layered
 * journal records).
 */
export type LiveCloseInput = Record<string, never>;

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
   * The DOWNLINK sink — an optional single sink where `stream.sendFrame(frame)`
   * delivers server→client frames. The runtime-attachable egress is
   * {@link LiveHarnessProtocol.onDownlink} (fan-out observers) — the media-transport
   * server half (the WS media lane on `@agentick/transport-websocket`, or the
   * in-process `inProcessLiveMedia`) subscribes there. This constructor option is
   * the single-sink convenience; both fire on `sendFrame`.
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
  private readonly downlinkObservers = new Set<(ref: MediaSessionRef, frame: MediaFrame) => void>();

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
      // This harness's `scopeId` IS its session id (every caller constructs it that
      // way), so it declares its own owning scope rather than making each caller
      // remember to. Declared HERE and not stamped per-op: if a future caller ever
      // passes a composed key, the `HookBridges` scope conformance fires instead of
      // the projection silently going dead.
      parentScope: { sessionId: scopeId },
      inheritedInterceptors: options.inheritedInterceptors,
      interceptorParent: options.interceptorParent,
      // `live:command:close` envelopes are bus-only — the house close-op rule
      // (`BaseHarness.close`'s contract note, matching `app:command:close-app`
      // and `gateway:command:close`): the body runs `super.close()`, so a
      // terminal appended afterwards could hit a journal an `onClose` handler
      // already tore down. `live:command:stop` keeps the default policy — a
      // stream teardown IS an audit-worthy event.
      policy: mergeLayered<JournalingPolicy>(DEFAULT_JOURNALING_POLICY, {
        override: { "live:command:close": "bus-only" },
      }),
    });
    this.onStreamCb = options.onStream;
    this.resolveSession = options.session;
    this.downlinkSink = options.downlinkSink;
  }

  // ─────────── start ───────────

  // TODO(ADR-92 family-3): `start` is the sync-return seam — it hands back a
  // `MediaSessionRef` synchronously, and a sync return cannot host the async
  // interceptor fold (same blocker as `tasks.submit`, documented at
  // `tasks/src/harness.ts`). Until Family 3 picks a shape — (a) async-ify the
  // verb, or (b) a provably-sync interceptor fast-path in the runtime lift —
  // stream birth is guardable only at the wire (`live/start`), not in process.
  // Do NOT wrap this in `runOperation` without resolving that first.
  start(streamId?: string): MediaSessionRef {
    const sid = streamId ?? `live:${ulid()}`;
    // NOT AN EVENT SCOPE — a data ref. This harness's `scopeId` IS its session id.
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

  onDownlink(cb: (ref: MediaSessionRef, frame: MediaFrame) => void): Unsubscribe {
    this.downlinkObservers.add(cb);
    return () => {
      this.downlinkObservers.delete(cb);
    };
  }

  interrupt(streamId: string, playedMs?: number): void {
    const state = this.streams.get(streamId);
    if (!state || state.closed) return;
    for (const cb of state.interruptListeners) cb(playedMs);
  }

  /**
   * Tear down one stream — the `live:command:stop` OPERATION (ADR 92 Family 2
   * §6). Behavior is unchanged (idempotent, emits `closed`, fires close
   * listeners); what is new is the envelope: a guard can veto a hangup, an
   * `onBeforeLiveStop` hook can observe the reason, and the teardown leaves an
   * audit record scoped to `{ sessionId, streamId }`.
   *
   * The wire ingress (`live/stop`) already ran under ADR 90's dispatch op and
   * lands here, so a remote hangup now produces the wire record AND this one —
   * two real layers, two linked records, per the ADR's layering principle.
   */
  async stop(
    streamId: string,
    opts?: { readonly hard?: boolean; readonly reason?: string },
  ): Promise<void> {
    await runHarnessProtocol(
      this.liveOp<LiveStopInput, void>(
        "stop",
        { streamId, ...omitUndefined({ hard: opts?.hard, reason: opts?.reason }) },
        { streamId },
        (input) => Effect.sync(() => this.stopBody(input)),
      ),
    );
  }

  /** The `live:command:stop` BODY — the pre-promotion `stop` verbatim. */
  private stopBody(input: LiveStopInput): void {
    const state = this.streams.get(input.streamId);
    if (!state || state.closed) return; // idempotent
    state.closed = true;
    this.streams.delete(input.streamId);
    this.emitState(input.streamId, "closed");
    for (const cb of state.closeListeners) cb();
    // Close the downlink half (deferred transport half is a no-op in v0 core).
    // `hard` vs graceful only differs at the transport half (deferred); it
    // rides the op input so the audit record carries it either way.
  }

  // ─────────── close ───────────

  /**
   * Harness-wide teardown — the `live:command:close` OPERATION (ADR 92 Family
   * 2 §6). Stops every live stream, then unwinds the substrate.
   *
   * Bus-only by policy (see the constructor): the body reaches `super.close()`,
   * which fires `onClose` handlers that may tear down the very journal a
   * terminal append would target.
   */
  override async close(): Promise<void> {
    await runHarnessProtocol(
      this.liveOp<LiveCloseInput, void>("close", {}, {}, () =>
        Effect.promise(() => this.closeBody()),
      ),
    );
  }

  /** The `live:command:close` BODY — the pre-promotion `close` verbatim. */
  private async closeBody(): Promise<void> {
    const ids = [...this.streams.keys()];
    for (const id of ids) await this.stop(id, { hard: true, reason: "harness_closed" });
    await super.close();
  }

  /**
   * Route a live verb's body through {@link BaseHarness.runOperation} — the
   * `sessionOp` pattern. Op name follows the house convention
   * (`<surface>:command:<verb>`), which `deriveHookNames` strips to the
   * `live:<verb>` CommandRegistry key.
   *
   * Declared here rather than via {@link BaseHarness.command} because the live
   * verbs are already reachable from the wire through the ADR 46 wire
   * extension (`live/stop`, see `wire.ts`) — a second inbox-addressable face
   * would be a parallel ingress path for the same verb, which ADR 51 forbids.
   */
  private liveOp<I, R>(
    verb: string,
    input: I,
    scope: { readonly streamId?: string },
    body: (input: I) => Effect.Effect<R, unknown, never>,
  ): Effect.Effect<R, unknown, never> {
    const op: Operation<I, R, unknown> = {
      opId: `live:${verb}:${ulid()}`,
      surface: "live",
      name: `live:command:${verb}`,
      // `parentScope` gap-fills the session; this op names only its own dims.
      scope,
      input,
    };
    return this.runOperation(op, body);
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
    for (const cb of this.downlinkObservers) cb(ref, frame);
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
        scope: {},
        payload,
      } as Parameters<typeof this.bus.append>[0]),
    ).catch(() => undefined);
  }
}
