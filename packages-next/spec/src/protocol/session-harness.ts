/**
 * SessionHarnessProtocol — the integration site for one agent session.
 *
 * The session harness is the user-facing entry point. Application code
 * holds a session reference, calls `send({ messages })`, and gets back
 * a `SessionExecutionHandle` (an `AsyncIterable<ProtocolEvent>` plus a
 * `.result: Promise<SendResult>`).
 *
 * Internally the session:
 *   1. Mounts the agent JSX into the reconciler (once, at construction).
 *   2. Provides `HookBridges` to the reconciler backed by session state
 *      — `TimelineHarnessProtocol` exposes the session's timeline log +
 *      projection, `KnobsHarnessProtocol` reads/writes knob values,
 *      `StateHarnessProtocol` carries the adopter K/V bag, etc.
 *   3. Delegates `send()` to the loop executor as a single execution.
 *   4. Implements `StateApplicator` — the loop's writes to session state
 *      land here (timeline appends, knob updates, channel publishes).
 *   5. Forwards tick-end lifecycle events to the reconciler so the
 *      JSX tree's `useOnTickEnd` hooks fire (Phase 4e+ extension).
 *
 * **Minimum 4e surface.** The blueprint specifies a richer protocol
 * (`spawn`, `pause`/`resume`, `inject`, `recover`, `hibernate`/`restore`,
 * `dispatch` from host, `channel`/`knob` handles). Those land in
 * follow-up phases without breaking the 4e contract.
 *
 * `[V1-INHERITED, REFINED]` — v1's `Session.send` is the lineage; the
 * 600-line `executeTick` is replaced by `LoopExecutorHarness`. v1's
 * `EventEmitter` for fan-out is replaced by the substrate's `EventBus`.
 * v1's `runWithContext` (ALS-based scope) is replaced by `withContext`
 * (FiberRef). v1's hand-rolled `Procedure<...>` wrapping is replaced
 * by `BaseHarness.runOperation`.
 *
 * @see docs/proposals/v2/blueprint/08-session-harness.md
 */

import type { CommandOutcome, TerminalEvent } from "../data/outcomes.js";
import type { ContentBlock } from "../data/content-blocks.js";
import type { LanguageModelStopReason, UsageStats } from "../data/execution-result.js";
import type { StreamEvent } from "../data/streaming.js";
import type { SessionStatus as BridgeSessionStatus } from "./hook-bridges.js";
import type { LoopToolResult } from "./loop-executor.js";
import type { EventBus } from "./bus.js";
import type { MessageInbox } from "./inbox.js";
import type { OperationJournal } from "./journal.js";

// ============================================================================
// SessionSubstrateParent — forward-reference shell for factories
// ============================================================================

/**
 * Forward-reference shell handed to session-level substrate factories
 * (`SessionHarnessOptions.bus / inbox / journal` and
 * `CreateSessionInput.bus / inbox / journal` when given a factory).
 *
 * The session's BaseHarness fields aren't wired yet at substrate-
 * resolution time; the shell exposes only what's safe at this phase:
 *
 *   - `id`: the session id (so factories can branch on it)
 *   - `metadata`: adopter bag (where tenant routing data flows)
 *   - `bus` / `inbox` / `journal`: the APP'S substrate, exposed as
 *     the default upstream for wrapping
 *   - `onClose(h)`: buffered close registration that replays onto
 *     the real harness after construction completes
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md §Two-phase construction
 */
export interface SessionSubstrateParent {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** App's substrate, exposed as the default upstream for wrapping. */
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
  readonly journal: OperationJournal;
  onClose(handler: () => void | Promise<void>): void;
}

// ============================================================================
// Message + TimelineEntry
// ============================================================================

/**
 * Message role. Mirrors `MessageEntry.role` from the rendered-tree spec,
 * widened with `"event"` for app-level state events that flow through
 * the timeline without participating in model context.
 */
export type SessionMessageRole = "user" | "assistant" | "system" | "tool" | "event" | (string & {});

/**
 * Persistence-shaped message — what the timeline stores. Carries the
 * same `role` + `content` shape as the rendered-tree's `MessageEntry`
 * but adds session-level metadata (visibility, tags, ts).
 */
export interface SessionMessage {
  readonly id: string;
  readonly role: SessionMessageRole;
  readonly content: readonly ContentBlock[];
  /** ISO milliseconds since epoch when the message was added to the timeline. */
  readonly ts: number;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Timeline entry — a persistence-shaped wrapper around a message.
 *
 * `[V1-INHERITED]` of `packages/shared/src/timeline.ts`. Future kinds
 * (state-change records, subscription receipts) extend the union.
 */
export interface TimelineEntry {
  readonly kind: "message";
  readonly message: SessionMessage;
  /**
   * Visibility control:
   *   - "model"    — included in context rendered to the model
   *   - "observer" — visible to bus subscribers; not to the model
   *   - "log"      — only in journal/log; not in any render
   *   Default: "model".
   */
  readonly visibility?: "model" | "observer" | "log";
  readonly tags?: readonly string[];
}

// ============================================================================
// SendInput + SendResult
// ============================================================================

/**
 * Caller-facing input to `session.send`. Carries the messages the
 * model should see plus optional component props and metadata.
 *
 * `[V1-INHERITED, REDUCED]` — v1's `SendInput` had structural escape
 * hatches (`system`/`grounding`/`sections`/`ephemeral`) for injecting
 * context without JSX. Deferred to a later phase; JSX is the primary
 * path for v2.
 */
export interface SendInput<P = unknown> {
  readonly messages?: ReadonlyArray<SendMessageInput>;
  readonly props?: P;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Per-call abort. */
  readonly signal?: AbortSignal;
  /** Override the default max tick bound. */
  readonly maxTicks?: number;
  /**
   * Per-call executor override. The session uses this executor for
   * this single send instead of the app-supplied default. Typed
   * `LanguageModelExecutor` (factory-form is resolved at App
   * construction; per-call switching needs an already-constructed
   * instance).
   */
  readonly executor?: import("./executor.js").LanguageModelExecutor;
  /**
   * Per-call execution target override. Useful when reusing a single
   * executor across multiple modelIds (e.g., switching to gpt-4o-mini
   * for cheap intermediate steps) without rebuilding the executor.
   */
  readonly target?: import("../data/execution-target.js").ExecutionTarget;
  /**
   * Per-call streaming flag. Overrides session + app defaults.
   *
   * Cascade resolution (most specific wins):
   *   SendInput.stream  >  CreateSessionInput.streaming
   *                     >  AppHarnessOptions.streaming
   *                     >  capability default (true when
   *                        `executor.executeStream` exists AND
   *                        `target.capabilities.supportsStreaming` ≠ false)
   *
   * When `true`: the loop uses `executor.executeStream` (if available);
   * the handle iterator yields delta-level `StreamEvent`s as they arrive.
   * When `false`: the loop uses `executor.execute`; the handle yields
   * only summary-level events (`message`, `content`, `tool-call`,
   * `reasoning`, plus orchestration + final result).
   */
  readonly stream?: boolean;
  /**
   * Execution-scoped tool declarations. Bound at send-time with
   * `binding: { scope: "execution", executionId }`, entered into the
   * tool executor's registry for the duration of this execution, and
   * removed when the execution closes.
   *
   * Sits between session and reconciler in the precedence ladder — an
   * execution-level tool overrides a session-level (and gateway/app/
   * extension) tool of the same name but is itself overridden by a
   * reconciler-emitted tool of the same name in the rendered tree.
   *
   * @see ToolBinding in `@agentick/spec-next` for the precedence ladder.
   */
  readonly tools?: ReadonlyArray<import("../data/declarations.js").ToolDeclaration>;
}

/**
 * Input shape for a message added to the timeline. The session
 * harness assigns `id` + `ts` if the caller omits them.
 */
export interface SendMessageInput {
  readonly id?: string;
  readonly role: SessionMessageRole;
  readonly content: string | readonly ContentBlock[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Final result resolved by `SessionExecutionHandle.result`.
 *
 * `[V1-INHERITED]` of `SendResult` in `packages/core/src/app/types.ts`.
 */
export interface SendResult {
  /** Concatenated text from all assistant messages produced. */
  readonly response: string;
  /** All content blocks the executor produced (text + tool_use + etc.). */
  readonly output: readonly ContentBlock[];
  /** Tool dispatch results accumulated across ticks. */
  readonly toolResults: readonly LoopToolResult[];
  readonly usage: UsageStats;
  readonly stopReason:
    | LanguageModelStopReason
    | "max_ticks"
    | "aborted"
    | "vetoed"
    | "executor_failed";
  readonly ticks: number;
  readonly executionId: string;
}

// ============================================================================
// SessionExecutionHandle — AsyncIterable + .result
// ============================================================================

/**
 * Dual-shape handle returned by `send()`.
 *
 * - As `AsyncIterable<StreamEvent>`: consumers iterate typed events
 *   (model deltas, tool dispatch lifecycle, tick lifecycle, execution
 *   lifecycle, final result) in real time. The session stamps a
 *   monotonic per-session `sequence` field on every event for
 *   ordering / replay / dedup.
 * - As `{ result: Promise<SendResult> }`: consumers await the final
 *   assembled result.
 *
 * Both shapes derive from the same execution — iterating the events
 * does not change the result; awaiting `.result` does not consume
 * events for other iterators. The session feeds the iterator via a
 * direct emit chain (loop → session → handle queue), NOT via bus
 * subscription — keeps per-session cost O(1) per event regardless of
 * how many concurrent sessions exist.
 *
 * Bus envelopes still fire for observability (devtools, telemetry,
 * `app.events()` subscribers), but in parallel — not on the handle's
 * hot path.
 *
 * The iterator completes after the final `result` StreamEvent is
 * yielded.
 */
export interface SessionExecutionHandle extends AsyncIterable<StreamEvent> {
  readonly executionId: string;
  readonly result: Promise<SendResult>;
  readonly status: "running" | "completed" | "error" | "aborted";
  abort(reason?: string): Promise<void>;
}

// ============================================================================
// State application — implemented by session, consumed by loop
// ============================================================================

export interface ApplyExecutorResultInput {
  readonly sessionId: string;
  readonly executionId: string;
  readonly tickId: string;
  readonly result: {
    readonly output: readonly ContentBlock[];
    readonly stopReason: string;
    readonly usage?: UsageStats;
  };
}

export interface ApplyToolResultsInput {
  readonly sessionId: string;
  readonly executionId: string;
  readonly tickId: string;
  readonly results: readonly LoopToolResult[];
}

export interface AppendEntryInput {
  readonly sessionId: string;
  readonly entry: {
    readonly role: SessionMessageRole;
    readonly content: readonly ContentBlock[];
  };
}

export interface ApplyResult {
  readonly appendedEntryIds: readonly string[];
}

// ============================================================================
// Lifecycle / state shapes
// ============================================================================

// `SessionStatus` is defined once in `./hook-bridges.ts` and reused
// here via the `BridgeSessionStatus` import. Re-exporting from this
// module would collide with the existing export in the protocol
// barrel.

/**
 * Read-only snapshot of session state. Returned by `snapshot()`. Used
 * by persistence backends + hibernate/restore (Phase 5).
 */
export interface SessionSnapshot {
  readonly specVersion: string;
  readonly id: string;
  readonly parentSessionId?: string;
  readonly status: BridgeSessionStatus;
  readonly currentTick: number;
  readonly timeline: readonly TimelineEntry[];
  readonly knobs: Readonly<Record<string, unknown>>;
  readonly usage: UsageStats;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Errors
// ============================================================================

export type SessionError =
  | { readonly _tag: "SessionClosedError"; readonly attemptedCommand: string }
  | { readonly _tag: "SessionBusyError"; readonly reason: string }
  | { readonly _tag: "TimelineError"; readonly reason: string }
  | { readonly _tag: "KnobError"; readonly knob: string; readonly reason: string }
  | { readonly _tag: "ChannelError"; readonly channel: string; readonly reason: string }
  | { readonly _tag: "ExecutionFailed"; readonly cause: unknown };

export type StateApplyError =
  | { readonly _tag: "TimelineWriteFailed"; readonly cause: unknown }
  | { readonly _tag: "SessionClosedError"; readonly attemptedCommand: string };

// ============================================================================
// Notify lifecycle (tick-end forwarding)
// ============================================================================

export interface NotifyTickEndInput {
  readonly sessionId: string;
  readonly executionId: string;
  readonly tickId: string;
  readonly outcome: CommandOutcome;
  readonly result?: unknown;
}

export type TickEndForwardDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "stop"; readonly reason?: string }
  | undefined;

// ============================================================================
// SessionHarnessProtocol — minimum 4e surface
// ============================================================================

/**
 * Methods every session harness MUST provide. Promise-typed at the
 * public surface (consistent with reconciler / executor / tool-executor
 * / loop-executor protocols). Implementations wrap internal bodies with
 * `runHarnessProtocol(Effect.suspend(...))`.
 *
 * @throws {SessionError}
 */
export interface SessionHarnessProtocol<P = unknown> {
  /**
   * Stable session identifier. Set at construction (from the
   * `CreateSessionInput.sessionId` or generated by the parent App);
   * never changes. Adopters use this to discriminate sessions in
   * cross-session observation, route messages, and persist
   * session-scoped data.
   */
  readonly id: string;

  /**
   * Primary entry point. Adds the supplied messages to the timeline
   * and runs ONE execution via the loop executor. Returns a handle
   * that is both an `AsyncIterable<ProtocolEvent>` (for streaming
   * observation) and carries a `.result: Promise<SendResult>` (for
   * the final outcome).
   *
   * @throws {SessionError}
   */
  send(input: SendInput<P>): Promise<SessionExecutionHandle>;

  /**
   * Capture the current state as a serializable snapshot.
   */
  snapshot(): SessionSnapshot;

  /**
   * Shut down. Future commands fail with `SessionClosedError`.
   * Idempotent.
   */
  close(): Promise<void>;

  /**
   * `StateApplicator` surface — consumed by the loop executor's
   * `applyExecutorResult` / `applyToolResults` / `appendEntry`
   * calls. Real writes to session state happen here; the
   * `NoopStateApplicator` placeholder used in earlier phases is
   * superseded by the session's own implementation.
   *
   * @throws {StateApplyError}
   */
  applyExecutorResult(input: ApplyExecutorResultInput): Promise<ApplyResult>;
  applyToolResults(input: ApplyToolResultsInput): Promise<ApplyResult>;
  appendEntry(input: AppendEntryInput): Promise<ApplyResult>;

  /**
   * Tick-end forwarding hook. The loop executor calls this between
   * ticks; the session forwards to the reconciler's `notifyLifecycle`
   * so the JSX tree's `useOnTickEnd` hooks observe the tick. The
   * returned `TickEndForwardDecision` lets in-tree hooks override
   * the loop's default continuation policy.
   *
   * Phase 4e default impl: returns `undefined` (use loop default).
   * Full hook integration arrives with the lifecycle wiring pass.
   */
  notifyLifecycle(input: NotifyTickEndInput): Promise<TickEndForwardDecision>;

  // ──────────────────────────────────────────────────────────────────
  // Extended interaction surface (Phase 4e+ — block 5 of the plan)
  //
  // Each method below is independent of the substrate phase contract;
  // they're conveniences sitting on top of the same primitives the
  // loop executor uses (timeline writes, tool dispatch, child session
  // construction).
  // ──────────────────────────────────────────────────────────────────

  /**
   * Spawn a child session. The parent's app provides the shared
   * substrate + sub-harnesses; the child gets its own sessionId and
   * timeline. When `input.send` is supplied, the spawn immediately
   * runs one execution against the child and returns the handle.
   * Otherwise the caller receives the child `SessionHarnessProtocol`
   * for further interaction.
   *
   * `[V1-INHERITED]` — collapses v1's `spawn(component, input?, opts?)`
   * into a single options object.
   *
   * @throws {SessionError} — `SessionClosedError` if the parent is
   *   shutting down; impl-specific failures otherwise.
   */
  spawn(input: SpawnInput<P>): Promise<SessionExecutionHandle | SessionHarnessProtocol<P>>;

  /**
   * Host-side tool dispatch. Invokes a registered tool by name with
   * the supplied input, bypassing the model. The dispatch flows
   * through the session's tool executor with `via: "dispatch"`, so
   * tools must declare `exposure: ["dispatch", ...]` to be reachable.
   *
   * Returns the tool's content blocks. Throws `ToolExecutorError`
   * (validation failure, permission denied, handler failure, etc.)
   * surfaced from the harness.
   */
  dispatch(name: string, input: Record<string, unknown>): Promise<readonly ContentBlock[]>;

  /**
   * Return a programmatic handle for a named channel. Each call
   * returns a new handle bound to the same name — handles are cheap
   * wrappers, not registered. Channel events flow on
   * `surface: "session"` with name `session:channel:<name>`.
   */
  channel<T = unknown>(name: string): ChannelHandle<T>;

  /**
   * Return a programmatic handle for a named knob. Wraps the
   * session's `KnobsHarnessProtocol`. Throws on `get()` / `set()` when
   * the knob is not registered (knobs come from the JSX tree via
   * `useKnob` or `knob(...)` declarations).
   */
  knob<T = unknown>(name: string): KnobHandle<T>;
}

// ============================================================================
// SessionHarnessFactory — deferred construction with shared substrate
// ============================================================================

export interface SessionHarnessFactoryDeps {
  readonly scopeId: string;
  readonly journal: import("./journal.js").OperationJournal;
  readonly bus: import("./bus.js").EventBus;
  readonly inbox: import("./inbox.js").MessageInbox;
}

/**
 * Deferred-construction form of `SessionHarnessProtocol`. Used by
 * `defineSession(...)` so the App can call the factory at session
 * creation time with the shared substrate.
 *
 * Marker symbol `sessionHarnessFactory` disambiguates a factory from a
 * pre-constructed instance.
 */
export interface SessionHarnessFactory<P = unknown> {
  readonly sessionHarnessFactory: true;
  (deps: SessionHarnessFactoryDeps): SessionHarnessProtocol<P>;
}

/** Type guard. */
export function isSessionHarnessFactory<P = unknown>(v: unknown): v is SessionHarnessFactory<P> {
  return (
    typeof v === "function" &&
    (v as { sessionHarnessFactory?: unknown }).sessionHarnessFactory === true
  );
}

// ============================================================================
// Inputs for the extended surface
// ============================================================================

export interface SpawnInput<P = unknown> {
  /**
   * Child agent root. Opaque to the session boundary — forwarded to
   * the bound reconciler at mount time. Same type contract as
   * `AppHarnessOptions.rootElement`.
   */
  readonly agent: unknown;
  /**
   * Optional initial send for the child. When supplied, the spawn
   * immediately runs one execution against the child session and
   * returns the resulting handle. When omitted, the spawn returns
   * the unbound child `SessionHarnessProtocol`.
   */
  readonly send?: SendInput<P>;
  /** Stable child session id. Generated if omitted. */
  readonly sessionId?: string;
  /** Caller metadata stored on the child's registry entry. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Initial component props for the child agent. */
  readonly initialProps?: P;
  /** Initial knob values for the child. */
  readonly initialKnobs?: Readonly<Record<string, unknown>>;
  /** Override the parent's max tick bound for this child. */
  readonly maxTicks?: number;
}

// ============================================================================
// Channel + knob handles (block 5 extras)
// ============================================================================

/**
 * Per-channel programmatic handle returned by `session.channel(name)`.
 * Ergonomic wrapper over the session's bus + (optional) channel
 * publisher — callers don't need to know the envelope shape.
 *
 * Bidirectional via `request` + `onRequest`:
 *   - `publish` / `subscribe` — pub/sub (fanout)
 *   - `request` / `onRequest` — correlated request/response (1:1)
 *
 * Subscribe listeners do NOT see request envelopes (those carry a
 * `requestType: "request"` metadata flag); request listeners do NOT
 * see plain publishes. Clean split — no defensive `if (ctx.respond)`
 * checks.
 */
export interface ChannelHandle<T = unknown> {
  readonly name: string;
  /** Publish a payload on this channel. Fanout — every subscriber sees it. */
  publish(payload: T, metadata?: Readonly<Record<string, unknown>>): Promise<void>;
  /**
   * Subscribe to publishes on this channel. Does NOT receive request
   * envelopes — use `onRequest` for those. Returns an unsubscribe fn.
   */
  subscribe(listener: (payload: T, meta: ChannelEventMeta) => void): () => void;
  /**
   * Send a request on this channel and await a correlated response.
   *
   * Publishes an envelope tagged with a correlationId + replyTo
   * (the owning harness's inbox address). The first matching
   * `request-response` inbox message resolves the Promise. Times out
   * after `opts.timeoutMs` if set. Honors `opts.signal` for abort.
   */
  request<TReq, TResp>(
    payload: TReq,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<TResp>;
  /**
   * Subscribe to *requests* on this channel. The listener receives a
   * `respond` callback bound to the request's correlationId — calling
   * it sends a `request-response` inbox message back to the requester.
   *
   * Returns an unsubscribe fn.
   */
  onRequest<TReq = unknown, TResp = unknown>(
    listener: (payload: TReq, ctx: RequestContext<TResp>) => void,
  ): () => void;
}

/**
 * Context passed to `onRequest` listeners. `respond` is the action
 * verb; `correlationId` + `replyTo` are exposed read-only for
 * debugging/logging.
 */
export interface RequestContext<TResp = unknown> {
  readonly correlationId: string;
  readonly replyTo: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  respond(payload: TResp): Promise<void>;
}

export interface ChannelEventMeta {
  readonly id: string;
  readonly timestamp: number;
  readonly channelSequence?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  readonly parentOpId?: string;
}

/**
 * Per-knob programmatic handle returned by `session.knob(name)`.
 * Wraps `KnobsHarnessProtocol` get/set/subscribe so callers can refer
 * to a knob by reference instead of repeating `id` strings.
 */
export interface KnobHandle<T = unknown> {
  readonly name: string;
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

// ============================================================================
// SpawnContext — the surface the parent app exposes to a child session
//
// Avoids leaking AppHarnessProtocol back into the session boundary. The
// session's `SessionHarnessOptions.spawnContext?` carries this; sessions
// without an app-level parent can't spawn.
// ============================================================================

export interface SpawnContext<P = unknown> {
  /**
   * Construct a new session bound to the same app. The parent passes
   * its own `sessionId` so the child's registry entry can link back.
   * The returned session is fully wired (substrate, sub-harnesses,
   * mountReady) and ready for `send`.
   */
  createChildSession(input: SpawnContextChildInput<P>): Promise<SessionHarnessProtocol<P>>;
}

export interface SpawnContextChildInput<P = unknown> {
  readonly parentSessionId: string;
  readonly agent: unknown;
  readonly sessionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly initialProps?: P;
  readonly initialKnobs?: Readonly<Record<string, unknown>>;
  readonly maxTicks?: number;
}

// Convenience re-exports for ergonomic imports.
export type { TerminalEvent };
