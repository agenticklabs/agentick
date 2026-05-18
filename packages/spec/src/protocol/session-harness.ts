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
 *      — `TimelineBridge` reads the session's accumulated timeline,
 *      `KnobBridge` reads/writes the session's knob map, etc.
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
import type { ProtocolEvent } from "../data/events.js";
import type { LanguageModelStopReason, UsageStats } from "../data/execution-result.js";
import type { SessionStatus as BridgeSessionStatus } from "./hook-bridges.js";
import type { LoopToolResult } from "./loop-executor.js";

// ============================================================================
// Message + TimelineEntry
// ============================================================================

/**
 * Message role. Mirrors `MessageEntry.role` from the rendered-tree spec,
 * widened with `"event"` for app-level state events that flow through
 * the timeline without participating in model context.
 */
export type SessionMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "event"
  | (string & {});

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
 * - As `AsyncIterable<ProtocolEvent>`: consumers iterate envelope events
 *   in real time (mirrors v1's per-event streaming).
 * - As `{ result: Promise<SendResult> }`: consumers await the final
 *   assembled result.
 *
 * Both shapes derive from the same execution — iterating the events
 * does not change the result; awaiting `.result` does not consume
 * events for other iterators. The bus underneath supports both.
 *
 * `[V1-INHERITED]` of `SessionExecutionHandle` in `packages/core/src/app/types.ts`.
 */
export interface SessionExecutionHandle extends AsyncIterable<ProtocolEvent> {
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
   * Synchronous read of the current timeline.
   */
  timeline(): readonly TimelineEntry[];

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
  spawn(
    input: SpawnInput<P>,
  ): Promise<SessionExecutionHandle | SessionHarnessProtocol<P>>;

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
  dispatch(
    name: string,
    input: Record<string, unknown>,
  ): Promise<readonly ContentBlock[]>;

  /**
   * Queue a message for the next execution. If no execution is
   * running, the message is prepended to the inputs of the caller's
   * subsequent `send(...)`. If an execution IS running, the message
   * is held until the current execution terminates, then folded into
   * the next `send(...)` automatically.
   *
   * `[V1-INHERITED]` — mirrors `session.queue(message)`.
   */
  queue(message: SendMessageInput): Promise<void>;

  /**
   * Write a timeline entry directly. Useful for user-side events,
   * out-of-band facts, or pre-populating context before a send. When
   * `opts.trigger` is true the session immediately runs a fresh
   * execution after the append (analogous to `send` with no new
   * messages) and returns the handle.
   *
   * Returns the appended entry id when not triggering; returns the
   * execution handle when triggering.
   */
  append(
    input: AppendEntryInput,
    opts?: { readonly trigger?: boolean },
  ): Promise<{ readonly entryId: string } | SessionExecutionHandle>;

  /**
   * Append an event-role observation to the timeline. Convenience
   * wrapper over `append` that sets `role: "event"` and stamps
   * `metadata.type` from the input. Observations are visible to the
   * model by default but never invoke handler logic.
   */
  observe(input: ObserveInput): Promise<{ readonly entryId: string }>;
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

export interface ObserveInput {
  /** Observation type label — stored in `metadata.type`. */
  readonly type: string;
  /** Either content blocks or a plain text payload (wrapped). */
  readonly content: string | readonly ContentBlock[];
  /** Additional metadata merged onto the message envelope. */
  readonly metadata?: Readonly<Record<string, unknown>>;
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
  createChildSession(
    input: SpawnContextChildInput<P>,
  ): Promise<SessionHarnessProtocol<P>>;
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
