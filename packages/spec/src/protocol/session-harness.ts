/**
 * SessionHarnessProtocol — the integration site for one agent session.
 *
 * The session harness is the user-facing entry point. Application code
 * holds a session reference, calls `send({ messages })`, and gets back
 * a `SessionExecutionHandle` (an `AsyncIterable<ProtocolEvent>` plus a
 * `.result: Promise<SendResult>`).
 *
 * Internally the session:
 *   1. Mounts the agent JSX into the compiler (once, at construction).
 *   2. Provides `HookBridges` to the compiler backed by session state
 *      — `TimelineHarnessProtocol` exposes the session's timeline log +
 *      projection, `KnobsHarnessProtocol` reads/writes knob values,
 *      `StateHarnessProtocol` carries the adopter K/V bag, etc.
 *   3. Delegates `send()` to the loop executor as a single execution.
 *   4. Implements `StateApplicator` — the loop's writes to session state
 *      land here (timeline appends, knob updates, channel publishes).
 *   5. Forwards tick-end lifecycle events to the compiler so the
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
import type { ModelInfoResult } from "../wire/params.js";
import type { EventEnvelope } from "../data/events.js";
import type { RenderedTree } from "../data/rendered-tree.js";
import type { ContentBlock } from "../data/content-blocks.js";
import type { LanguageModelStopReason, StopCause, UsageStats } from "../data/execution-result.js";
import type { TickResult } from "./loop-executor.js";
import type { LanguageModelInput } from "./executor.js";
import type { StreamEvent } from "../data/streaming.js";
import type { SessionStatus as BridgeSessionStatus } from "./hook-bridges.js";
import type { LoopToolResult } from "./loop-executor.js";
import type { EventBus } from "./bus.js";
import type { MessageInbox, Unsubscribe } from "./inbox.js";
import type { ToolsHandle } from "./tool-executor.js";
import type { OperationJournal } from "./journal.js";
import type { EscalationInterceptor } from "./escalation.js";

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
  readonly metadata?: SessionMessageMetadata;
}

/**
 * Message metadata — an open bag with blessed provenance keys (ADR 53).
 * The framework stamps `executionId`/`tickId` on entries it creates
 * during an execution, and `usage` on every execution-produced
 * ASSISTANT entry (one tick = one generation = one assistant entry).
 * Imported/seeded entries may omit all three. Adopter keys ride the
 * index signature as before.
 */
export interface SessionMessageMetadata {
  readonly executionId?: string;
  readonly tickId?: string;
  /** 1-based index of this tick within its execution — the loop's ordinal, stamped alongside `tickId`. */
  readonly tickIndex?: number;
  /** The generation's usage — execution-produced assistant entries. */
  readonly usage?: import("../data/execution-result.js").UsageStats;
  /**
   * WHICH model produced this generation. Stamped alongside `usage`
   * because usage without model identity cannot be priced, and a session
   * changes model more often than the flat aggregate admits.
   */
  readonly model?: Pick<
    import("../data/execution-target.js").ExecutionTarget,
    "provider" | "modelId"
  >;
  /**
   * The generation's cost, computed ONCE at act time against the rate
   * card in force then. Never recomputed — a price published tomorrow
   * must not reprice this record. Absent = the tick was UNPRICED, which
   * is a fact, not a zero.
   *
   * @see docs/proposals/v2/usage-cost.md §5
   */
  readonly cost?: import("../data/usage-cost.js").Cost;
  readonly [key: string]: unknown;
}

/**
 * Timeline entries — persistence-shaped records in the conversation log.
 *
 * `[V1-INHERITED]` message shape from `packages/shared/src/timeline.ts`;
 * the union gained its first non-message kind with ADR 53's turn
 * boundary.
 */
export type TimelineEntry = MessageTimelineEntry | TurnBoundaryEntry;

export interface MessageTimelineEntry {
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

/**
 * Turn boundary (ADR 53) — a CONVERSATION-domain fact: "a turn ended
 * here." The framework's execution is the mechanism that produced the
 * turn, attached as provenance; ticks never become entries. Always
 * `visibility: "log"` semantics: never rendered to the model.
 *
 * **The framework reads this for nothing.** It is a record, not a control signal — see
 * `TimelineHarness.endTurn`. An earlier version of this docblock claimed a committed
 * offset "is derived by fold" from it; no such fold exists, and the claim outlived the
 * intent by long enough to be worth correcting rather than implementing.
 *
 * What the fold WOULD be good for is an application's own concern: input entries appended
 * after the last `outcome: "succeeded"` boundary are the entries a successful request has
 * never carried, so a turn that starts failing narrows its suspects to exactly that window
 * — the `git bisect` range, established for free rather than searched for. That is a
 * ten-line fold over data the application already owns, which is why it lives there and
 * not here. What the application CANNOT derive is `target`, below.
 */
export interface TurnBoundaryEntry {
  readonly kind: "boundary";
  readonly boundary: {
    readonly executionId: string;
    /**
     * How the turn ended, as the CONVERSATION sees it.
     *
     * `vetoed` is its own member and not folded into `failed`, because a turn a
     * guard refused is not a turn that broke — and the two need different words
     * on screen (a failure invites a retry; a veto does not). The loop resolves a
     * veto as a succeeded terminal carrying `stopReason: "vetoed"`, so before this
     * member existed the session recorded it as `succeeded`: a refused turn was
     * indistinguishable on the timeline from one that answered. The very site that
     * maps this already refused to launder a provider failure; it laundered a veto.
     */
    readonly outcome: "succeeded" | "failed" | "aborted" | "vetoed";
    /** The TURN's aggregate usage — may exceed the entry-sum when a
     *  tick billed tokens but appended no assistant entry. */
    readonly usage?: import("../data/execution-result.js").UsageStats;
    /** The turn's per-model breakdown, keyed `` `${provider}/${modelId}` ``. */
    readonly byModel?: Readonly<Record<string, import("../data/usage-cost.js").ModelUsage>>;
    /** The turn's cost — `partial` when any tick was unpriced. */
    readonly cost?: import("../data/usage-cost.js").CostRollup;
    /**
     * WHY the turn ended badly — see {@link StopCause}. Present on `failed` and
     * `vetoed`, when a cause was carried.
     *
     * This is the DURABLE account, and the only one a reloaded client can read: a
     * turn that dies before its first tick appends no assistant entry, so this
     * boundary is the sole evidence on the timeline that the turn happened at all.
     * Recording the outcome without the cause (which is what shipped first) leaves
     * every consumer — a UI, a replay, an eval — able to say a turn ended badly and
     * unable to say why.
     */
    readonly stopCause?: StopCause;
    /**
     * WHICH target ran this turn — the fact that makes a "last known good" watermark
     * sound, and the one an application cannot derive from its own log.
     *
     * Every turn replays the whole conversation, so a turn that SUCCEEDED is a proof of
     * projectability: every entry it carried was accepted. That makes the entries appended
     * since the last success the natural suspect window when a turn starts failing — the
     * `git bisect` range, established for free instead of searched for.
     *
     * The proof is only about the target that gave it. A `withFallback` failover, a model
     * swap, or a knob change means "accepted by A" says nothing about B, and a watermark
     * that ignores that lies exactly when the conversation has just changed underneath it.
     * Recording provider + modelId is what lets a reader tell a comparable success from an
     * incomparable one.
     *
     * Absent when the turn ended before a target was resolved.
     */
    readonly target?: {
      readonly provider?: string;
      readonly modelId?: string;
    };
  };
  /** ISO milliseconds when the turn ended. */
  readonly ts: number;
  readonly visibility?: "log";
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
export interface SendInput<P = unknown, T = unknown> {
  /**
   * The client connection this turn was asked from. Stamped by the wire
   * boundary; absent for an in-process `send`, a cron trigger, or a spawn,
   * which genuinely have no connection.
   *
   * Carried onto the EXECUTION rather than read from ctx at use time, because
   * the work that needs it — relaying a tool call back to the asking client —
   * happens deep inside the run, after any particular request has returned.
   */
  readonly connectionId?: string;
  /**
   * The client this turn was asked from. Stamped by the wire boundary; absent
   * for an in-process `send`, a cron trigger, or a spawn.
   *
   * The CLIENT rather than the connection, because a tool call outstanding
   * when the socket drops has to still be addressed to the same tab when it
   * comes back — and the connection id it reconnects with is a new one.
   */
  readonly clientId?: string;
  readonly messages?: ReadonlyArray<SendMessageInput>;
  readonly props?: P;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Per-call abort. */
  readonly signal?: AbortSignal;
  /** Override the default max tick bound. */
  readonly maxTicks?: number;
  /**
   * Per-call model-executor override. The session uses this
   * model-executor for this single send instead of the app-supplied
   * default. Typed `LanguageModelExecutor` (factory-form is resolved at
   * App construction; per-call switching needs an already-constructed
   * instance).
   */
  readonly modelExecutor?: import("./executor.js").LanguageModelExecutor;
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
   * Sits between session and compiler in the precedence ladder — an
   * execution-level tool overrides a session-level (and gateway/app/
   * extension) tool of the same name but is itself overridden by a
   * compiler-emitted tool of the same name in the rendered tree.
   *
   * @see ToolBinding in `@agentick/spec` for the precedence ladder.
   */
  readonly tools?: ReadonlyArray<import("../data/declarations.js").ToolDeclaration>;
  /**
   * Restriction: when present, only tools whose canonical name is listed are
   * exposed to the MODEL this execution. Dispatch-door tools are unaffected.
   * Composes with `tools` (additive): an execution-scoped tool still must be
   * named here to reach the model. The structured-output terminal tool is
   * exempt (loop-injected after restriction). Canonical names (not aliases).
   * Absent = no restriction.
   */
  readonly allowedTools?: readonly string[];
  /**
   * Concurrency for dispatching this send's per-tick tool calls (ADR 77
   * Stage 5). `"unbounded"` (default) runs a tick's tool calls
   * concurrently; a positive integer caps them; `1` is sequential.
   * Results always stay in call-order.
   */
  readonly toolConcurrency?: number | "unbounded";
  /**
   * Optional execution timeout (ms) for this send (ADR 77 Stage 5). No
   * default. On expiry the execution structurally aborts (in-flight
   * model/tool work torn down) and the handle resolves with a canceled
   * outcome (`stopReason: "timeout"`).
   */
  readonly timeoutMs?: number;
  /**
   * Behavior for a send that RACES an in-flight execution (ADR 53 §5).
   *
   *   - `"steer"` — inject into the CURRENTLY RUNNING execution. The
   *     messages are enqueued onto a per-execution steer queue and
   *     drained at the next tick boundary — after the tick's tool
   *     results apply, before the next render — so the model sees them
   *     on the NEXT tick of the SAME execution (no new execution, no
   *     settle wait; the call returns the in-flight handle). With NO
   *     execution running, degrades to a normal fresh send.
   *   - `"queue"` — wait for the session to FULLY quiesce (the
   *     in-flight execution AND its durability barrier complete and the
   *     session returns to idle), THEN run as a NEW execution. With no
   *     execution running, identical to a normal send.
   *
   * The distinction only matters while an execution is in flight; both
   * modes behave identically on an idle session (fresh execution).
   *
   * **Smart default** (unset). Resolves per send shape: a send carrying
   * structured output ({@link output} or {@link responseFormat}) defaults
   * to `"queue"` — a steer injects into an execution whose final turn is
   * already committed, so it has no turn to shape; queueing runs a fresh
   * execution that can. A plain send defaults to `"steer"` (ADR 53 §5
   * join). The {@link SteerCannotCarryStructuredOutput} join-point guard
   * therefore fires ONLY on an EXPLICIT `onBusy: "steer"` carrying
   * structured output that actually joins an in-flight execution; implicit
   * structured sends queue instead of erroring.
   */
  readonly onBusy?: OnBusy;
  /**
   * Per-call telemetry identity (telemetry rung 2 — the "functionId" move).
   * When telemetry enrichment is on (`createApp({ telemetry })`), these stamp
   * onto EVERY span this send touches — ticks, model calls, tool dispatches —
   * via the tier-4 call-scoped middleware seam. Use it to attribute one send to
   * a named logical function and to carry per-call metadata known at send time.
   *
   *   - `functionId` — a logical name for THIS call (e.g. `"summarize"`,
   *     `"triage"`). **Defaults to the app's `name`** (`createApp({ name })`)
   *     when unset — so a single-purpose app gets meaningful function-level
   *     traces with zero telemetry config; set it per-send for a multi-function
   *     app. Stamped as `<ns>.function.id` (`<ns>` = the telemetry namespace,
   *     default `agentick`).
   *   - `metadata` — arbitrary per-call attributes, stamped as
   *     `<ns>.metadata.<key>`. An open bag — no framework change to add a key.
   *
   * A no-op when telemetry enrichment is off (no interceptor is registered).
   * See "Observability" in `@agentick/runtime`'s README for the full model.
   */
  readonly telemetry?: SendTelemetry;
  /**
   * Structured final turn — declarative / wire-safe form
   * (trail-response-format-send). The existing JSON-shaped
   * {@link import("../data/rendered-tree.js").ResponseFormat} the compiled
   * tree already carries on `config.responseFormat`.
   *
   * Applied on EVERY tick of this send, overriding both the tree-level
   * `<model responseFormat>` AND a per-tick `<Model>`-declared
   * `parameters.responseFormat` — explicit-beats-ambient. Fully
   * serializable: crosses `session/send` unchanged (see
   * `SessionSendParams.responseFormat`).
   *
   * Providers that support tools + response_format together honor it
   * natively (OpenAI, Google); Anthropic + ai-sdk currently drop it
   * (`TODO(trail-anthropic-structured)` / `TODO(trail-aisdk-experimental-
   * output)`).
   *
   * For the LIVE-schema sugar + validated `SendResult.data`, use
   * {@link output} — the terminal-tool strategy that erases the provider gap
   * (three-audiences-plan §B2).
   */
  readonly responseFormat?: import("../data/rendered-tree.js").ResponseFormat;
  /**
   * Structured final turn — LIVE-schema sugar (three-audiences-plan §B2).
   * "THIS execution produces this shape." A `StandardSchemaV1` (Zod, Valibot,
   * `jsonSchema()`, …); the session derives an {@link import("../data/declarations.js").OutputSpec}
   * and threads it to the loop, which delivers the answer via a synthetic
   * TERMINAL TOOL (its `inputSchema` IS this schema) when the turn exposes
   * model tools, or a plain `responseFormat` directive on a bare send. The
   * captured value is validated against this schema into {@link SendResult.data}
   * (typed `ResponseValidationError` on mismatch — errors over nulls).
   *
   * In-process only: a validator is a runtime function and CANNOT cross the
   * wire, so `output` is rejected at the wire boundary — declare
   * `responseFormat` there instead and parse client-side. Overrides a
   * tree-level `<Output>` declaration (explicit-beats-ambient).
   *
   * `skills.run` composes on this. See the plan's honest guarantees chain
   * (natural path → forced wrap-up tick → typed failure) before framing it as
   * a general structured-output promise.
   */
  readonly output?: import("../data/standard-schema.js").StandardSchemaV1<unknown, T>;
}

/**
 * Per-call telemetry identity for {@link SendInput.telemetry} (rung 2). The
 * `functionId` is Vercel-AI's `functionId` move — a logical name attributed to
 * every span in the send; `metadata` is an open per-call attribute bag.
 */
export interface SendTelemetry {
  readonly functionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Busy-send behavior for {@link SendInput.onBusy}. See that field for the
 * full semantics, including the smart default when unset.
 */
export type OnBusy = "steer" | "queue";

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
export interface SendResult<T = unknown> {
  /** Concatenated text from all assistant messages produced. */
  readonly response: string;
  /** All content blocks the executor produced (text + tool_use + etc.). */
  readonly output: readonly ContentBlock[];
  /** Tool dispatch results accumulated across ticks. */
  readonly toolResults: readonly LoopToolResult[];
  /** Flat totals across every model this send touched. Safe to sum; meaningless to price. */
  readonly usage: UsageStats;
  /** Per-model breakdown, keyed `` `${provider}/${modelId}` `` — what makes cost computable. */
  readonly byModel?: Readonly<Record<string, import("../data/usage-cost.js").ModelUsage>>;
  /**
   * What this send cost. Absent when it recorded no usage; `partial`
   * when any tick was unpriced — an unpriced tick never folds in as
   * zero, so a total is complete or explicitly says how much of itself
   * is missing.
   *
   * @see docs/proposals/v2/usage-cost.md §6
   */
  readonly cost?: import("../data/usage-cost.js").CostRollup;
  readonly stopReason:
    | LanguageModelStopReason
    | "max_ticks"
    | "aborted"
    | "vetoed"
    | "executor_failed"
    | "timeout"
    // §B2 — the declared structured output was delivered via the terminal tool
    // (natural or forced wrap-up path); `data` carries the validated value.
    // Reported instead of the provider's `tool_use`. The `responseFormat`
    // strategy keeps the provider stop reason.
    | "output_delivered";
  readonly ticks: number;
  readonly executionId: string;
  /**
   * The typed, schema-validated structured output (three-audiences-plan §B2).
   * Present ONLY when a live {@link SendInput.output} schema was supplied and
   * the execution delivered a conforming value (the terminal tool's validated
   * input, or the validated final text on the `responseFormat` strategy). A
   * schema that was supplied but not met rejects `handle.result` with
   * `ResponseValidationError` rather than resolving an unvalidated `data`. The
   * wire `SendResult` never carries `data` — the schema never crossed.
   */
  readonly data?: T;
  /**
   * WHY the turn stopped badly, when it did — lifted verbatim from
   * {@link ExecutionRunResult.stopCause}. See {@link StopCause}.
   *
   * `stopReason: "executor_failed"` and `"vetoed"` both RESOLVE this promise: the
   * turn ran, and being refused by a provider or by a guard is an outcome rather
   * than a broken contract. So a caller's `.catch` never fires, and before this
   * field the resolved result said only `executor_failed` / `vetoed` — a caller who
   * wanted the cause had nowhere to read it and no way to know one existed.
   */
  readonly stopCause?: StopCause;
}

// ============================================================================
// SessionExecutionHandle — events() + .result
// ============================================================================

/**
 * Handle returned by `send()`.
 *
 * - `events(): AsyncIterable<StreamEvent>`: consumers iterate typed
 *   events (model deltas, tool dispatch lifecycle, tick lifecycle,
 *   execution lifecycle, final result) in real time. The session stamps
 *   a monotonic per-session `sequence` field on every event for
 *   ordering / replay / dedup.
 * - `{ result: Promise<SendResult> }`: consumers await the final
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
export interface SessionExecutionHandle<T = unknown> {
  readonly executionId: string;
  readonly result: Promise<SendResult<T>>;
  readonly status: "running" | "completed" | "error" | "aborted";
  /**
   * The event stream — `for await (const ev of handle.events())`.
   */
  events(): AsyncIterable<StreamEvent>;
  /**
   * The same event stream as a WHATWG {@link ReadableStream} — the bridge to
   * the web-streams ecosystem (`pipeThrough` transforms, `tee`, manual
   * backpressure-aware reads). Backed by the same underlying queue as
   * {@link events}; consuming one draws from the shared queue, so read a handle
   * through `readable()` OR `events()`, not both at once.
   */
  readable(): ReadableStream<StreamEvent>;
  /**
   * Pipe the event stream to a WHATWG {@link WritableStream}, honoring the
   * destination's backpressure — a slow sink's `write()` gates the drain, and
   * that IS the pacing mechanism (a rate-limited sink needs no extra config).
   * Sugar over `readable().pipeTo(destination, options)`.
   *
   * `throttleMs` optionally enforces a minimum gap between writes (a
   * `smoothStream`-style cadence) on top of backpressure; omit it and
   * backpressure alone paces. The remaining options mirror
   * `ReadableStream.prototype.pipeTo`.
   */
  pipeTo(destination: WritableStream<StreamEvent>, options?: StreamPipeToOptions): Promise<void>;
  abort(reason?: string): Promise<void>;
}

/**
 * Options for {@link SessionExecutionHandle.pipeTo}. Mirrors the standard
 * `StreamPipeOptions` (`preventClose`/`preventAbort`/`preventCancel`/`signal`)
 * and adds `throttleMs` — a minimum inter-write gap for rate-limited sinks.
 */
export interface StreamPipeToOptions {
  readonly preventClose?: boolean;
  readonly preventAbort?: boolean;
  readonly preventCancel?: boolean;
  readonly signal?: AbortSignal;
  /** Minimum milliseconds between writes to the destination. Omit for backpressure-only pacing. */
  readonly throttleMs?: number;
}

// ============================================================================
// Late-bound send capability — the skills.run injection seam (C-core)
// ============================================================================

/**
 * The MINIMAL slice of a session a late-bound runner needs: one `send`.
 *
 * `skills.run` (three-audiences-plan §C) is a send primed with a skill's
 * content, riding the structured-output path. The skills harness is
 * constructed from substrate ALONE — it has no session access — so the send
 * capability is injected post-construction via {@link RunnerBindable.bindRunner}
 * (the `adoptTelemetry` late-bind precedent). Typing the capability as this
 * narrow function keeps the skills package free of a `@agentick/session` edge: it
 * speaks only this spec type, never the concrete session.
 */
export type SessionSendCapability<P = unknown> = (
  input: SendInput<P>,
) => Promise<SessionExecutionHandle>;

/**
 * Feature contract for a harness that runs sends on behalf of an adopter but
 * is constructed without session access. The composition root (the App's
 * session-construction fold) scans the session's extension bridges and, for
 * any that duck-type to this contract, injects the session's own `send` —
 * exactly as {@link import("./hook-bridges.js").CheckpointCapable} is
 * feature-detected for the checkpoint fan-out.
 * No hardcoded slot names, per ADR 27; the skills harness is the first (and,
 * today, only) consumer.
 *
 * `bindRunner` is an INJECTION seam, not a user-facing method — it lives on the
 * harness, never on the curated `SkillsHandle` the adopter holds.
 */
export interface RunnerBindable {
  bindRunner(send: SessionSendCapability): void;
  /**
   * Optional sibling to {@link bindRunner} — inject an ISOLATED send
   * capability (three-audiences-plan §C split, item 3). Where `bindRunner`
   * routes a send into the CURRENT session, an isolation runner routes it
   * into a fresh {@link SessionHarnessProtocol.fork} (a same-image,
   * copied-state child) disposed after the run settles. The skills harness
   * uses it for `skills.run(name, { isolate: true })`. A harness with NO
   * isolation runner bound falls back to whatever it did before (skills:
   * throw `SkillIsolationUnavailable`).
   */
  bindIsolationRunner?(runner: SessionSendCapability): void;
}

/**
 * Runtime feature-detection for {@link RunnerBindable}. Sibling to
 * {@link import("./hook-bridges.js").isCheckpointCapable}.
 */
export function isRunnerBindable(x: unknown): x is RunnerBindable {
  return (
    x !== null &&
    typeof x === "object" &&
    typeof (x as { bindRunner?: unknown }).bindRunner === "function"
  );
}

// ============================================================================
// State application — implemented by session, consumed by loop
// ============================================================================

/**
 * The ONE input type for `applyExecutorResult`, shared by the Promise
 * facade and the Effect twin (`StateApplicatorFx`).
 *
 * It was two structural copies until they drifted twice over: the facade
 * declared a narrow projection (`output` / `stopReason` / `usage?`) while
 * the twin took a whole {@link LanguageModelExecutionResult}, and only the
 * facade learned about `cost` / `model`. Every real caller passes a full
 * executor result, so the narrow shape was the wrong one — and because the
 * loop forwards via a spread, neither disagreement ever went red.
 */
export interface ApplyExecutorResultInput {
  readonly sessionId: string;
  readonly executionId: string;
  readonly tickId: string;
  readonly tickIndex?: number;
  readonly result: import("../data/execution-result.js").LanguageModelExecutionResult & {
    /**
     * The tick's cost, stamped ONCE at settlement against the resolved
     * target. Absent = UNPRICED — never zero.
     */
    readonly cost?: import("../data/usage-cost.js").Cost;
    /**
     * The model this tick actually resolved to, after the `<Model>`
     * cascade. Carried with the cost because usage without model identity
     * cannot be priced.
     */
    readonly model?: Pick<
      import("../data/execution-target.js").ExecutionTarget,
      "provider" | "modelId"
    >;
  };
}

export interface ApplyToolResultsInput {
  readonly sessionId: string;
  readonly executionId: string;
  readonly tickId: string;
  readonly tickIndex?: number;
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
/**
 * What {@link SessionHarnessProtocol.dryRun} produced. Deliberately the same
 * shape as the request half of a recorded round trip, so one surface renders a
 * live preview and recorded history alike.
 */
export interface SessionDryRunResult {
  /** What the components produced, pre-dialect. */
  readonly tree: RenderedTree;
  /** What the MODEL sees — messages, tools, system. */
  readonly input: LanguageModelInput;
  /** What would go on the wire. Absent when the executor has no adapter. */
  readonly request?: unknown;
}

/**
 * Why a session is being torn down — the provenance dimension of the
 * `session:close` operation (ADR 92 Family 2 §5).
 *
 *   `"closed"`   — a genuine session END: explicit teardown, a `runOnce`
 *                  auto-dispose, a parent disposing a spawned child. The
 *                  app-level `onSessionClose` handlers fire.
 *   `"evicted"`  — transparent PAGING: the app's soft LRU cap or idle sweep is
 *                  releasing memory. The durable `SessionRecord` + timeline
 *                  store survive and the session reconstructs on its next open,
 *                  so this is not a lifecycle end and `onSessionClose` does NOT
 *                  fire.
 *   `"shutdown"` — the PROCESS is leaving: `closeApp` (and the gateway close
 *                  above it) draining its registry. Leaving memory is not a
 *                  lifecycle end, so this lands where eviction lands — the one
 *                  difference being that shutdown cannot refuse an in-flight
 *                  session, it aborts the execution and pages out anyway.
 *
 * The status a torn-down session's record settles on is the ONE thing that
 * reads this: `"closed"` is terminal (the resume door refuses it), so it is
 * reserved for explicit intent, and every other reason lands on `hibernated`.
 * Otherwise these are facts for an operator reading the journal, not decisions.
 */
export type SessionCloseReason = "closed" | "evicted" | "shutdown";

/** Input to the `session:close` command. */
export interface SessionCloseInput {
  /** Provenance of the teardown. Defaults to `"closed"`. */
  readonly reason?: SessionCloseReason;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Session + state-apply errors — migrated to class hierarchy (ADR 41
 * cluster 2). Re-exports from `../errors/lifecycle.js`.
 *
 * Wire tag rename: `"TimelineError"` → `"SessionTimelineError"` to
 * remove a namespace collision with the planned `TimelineError`
 * abstract class from the execution cluster.
 */
export {
  ChannelError,
  ExecutionFailed,
  KnobError,
  SessionBusyError,
  SessionClosedError,
  SessionError,
  type SessionErrorChannel,
  SessionTimelineError,
  SpawnDepthExceededError,
  type StateApplyError,
  type StateApplyErrorChannel,
  TimelineWriteFailed,
} from "../errors/lifecycle.js";

// ============================================================================
// Notify lifecycle (tick-end forwarding)
// ============================================================================

export interface NotifyTickEndInput {
  readonly sessionId: string;
  readonly executionId: string;
  readonly tickId: string;
  /**
   * `"succeeded"` or `"failed"` (ADR 99 slice 2 — a failed tick reaches the
   * fold so a policy can re-issue it). `"canceled"` / `"vetoed"` never arrive:
   * an abort is not a failure to recover from, and a veto is a policy decision
   * that already happened.
   */
  readonly outcome: CommandOutcome;
  /**
   * The settled {@link TickResult} for the tick that just completed
   * (ADR 67). The loop builds it — the executor terminal, this tick's
   * tool results, and the loop's provisional continuation disposition
   * (`shouldContinue`, pre-predicate) — and passes it here AFTER the
   * compiler tick-end has settled the tree. The session's continuation
   * predicates (gates, steering) read it to compose the returned
   * {@link TickEndForwardDecision}. Optional only because a headless
   * host may call `notifyLifecycle` without a tick body.
   */
  readonly result?: TickResult;
}

export type TickEndForwardDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "stop"; readonly reason?: string }
  | undefined;

/** What the failed tick a {@link TickFailurePolicy} is judging knows about itself. */
export interface TickFailureInfo {
  readonly tickIndex: number;
  /** Consecutive failed ticks including this one — 1 on the first failure. */
  readonly consecutiveFailures: number;
}

/**
 * Whether a failed tick is re-issued (ADR 99 slice 3).
 *
 * A failed tick persists nothing, so `"retry"` is an identical model request
 * as a fresh tick — promising for nondeterministic model garbage
 * (`MalformedModelOutput`), futile and billed for a deterministically bad
 * request. Only the adapter can tell those apart, which is why this is keyed
 * by the `_tag` the adapters already emit: the taxonomy IS the config
 * namespace, so there is no `max<Mode>Retries` option per failure class, and a
 * typo breaks at compile time.
 *
 * The table form is a per-class retry BUDGET — `{ MalformedModelOutput: 1 }`
 * retries that class once — desugared into the predicate form. Supplying
 * either form REPLACES the bundled default entirely; the loop's
 * `maxConsecutiveFailedTicks` and `maxTicks` still bound both.
 *
 * Layering: an adapter-level `withRetry` owns pre-first-chunk transient
 * transport errors (429/5xx/network). This owns post-stream failures — the
 * classes `withRetry` correctly refuses to replay.
 */
export type TickFailurePolicy =
  | Partial<Record<import("../errors/harnesses.js").ExecuteError["_tag"], number>>
  | ((
      error: import("../errors/harnesses.js").ExecuteErrorChannel,
      info: TickFailureInfo,
    ) => "retry" | "stop");

// ============================================================================
// SessionHarnessProtocol — minimum 4e surface
// ============================================================================

/**
 * Options for {@link SessionHarnessProtocol.abort}.
 *
 * **The cancellation ladder** — four verbs, strictly increasing in what they
 * take away. Each rung does everything the rung above it does, and more:
 *
 * | verb | cancels | disposes | detached tasks | durable record |
 * | --- | --- | --- | --- | --- |
 * | `abort()` | this session's current execution | no | keep running | untouched |
 * | `abort({ cascade: true })` | ⤷ plus every live descendant's | no | keep running | untouched |
 * | `close()` | this session's current execution | this session + its spawned children | ABANDONED (ADR 68) | survives as history |
 * | `destroySession()` | the whole live subtree's | the whole live subtree | CANCELLED | DELETED |
 *
 * The two abort rungs are the only reversible ones: the session stays open,
 * addressable, and immediately sendable again.
 */
export interface SessionAbortOptions {
  /**
   * Abort the live spawn subtree, not just this session — every live
   * DESCENDANT session's current execution, deepest-first (a child stops
   * before the parent waiting on it unwinds), then this session's own.
   *
   * Scope only. Cascade does not dispose anything, does not touch the durable
   * record, and does not cancel detached tasks — for those, climb the ladder
   * above. Each aborted execution mints its own ordinary `loop:abort`
   * operation, so a guard sees the same op it always did: cascade changes the
   * SCOPE of an abort, never its KIND.
   *
   * Defaults to `false` — the conservative reading of a bare `abort()`, which
   * has always meant "stop what I'm doing", never "stop my whole agent tree".
   *
   * Reaching descendants requires the app-level registry (the session's
   * `SpawnContext`). A session constructed without one has no children to
   * reach, so cascade degrades to the plain self-abort.
   */
  readonly cascade?: boolean;
}

/**
 * Methods every session harness MUST provide. Promise-typed at the
 * public surface (consistent with compiler / executor / tool-executor
 * / loop-executor protocols). Implementations wrap internal bodies with
 * `runHarnessProtocol(Effect.suspend(...))`.
 *
 * @throws {SessionError}
 */
export interface SessionHarnessProtocol<P = unknown> {
  /** Construction-bound owning principal (ADR 48) — target-rule input. */
  readonly principal?: string | undefined;
  /**
   * Scope ceiling (#199) — construction-bound structural config, same
   * pattern as `principal`: a wire caller whose credential claims do
   * not COVER (glob-aware) every listed scope is Forbidden at the
   * dispatch gate, regardless of grants — checked structurally before
   * policy and before any authorizer short-circuit. Server-declared
   * only (CreateSessionInput; deliberately NOT settable over the wire).
   * Requires claim-carrying identities: under a pure grant-table
   * deployment no caller carries claims, so a non-empty ceiling makes
   * the session wire-inaccessible — by design (the ceiling demands
   * credential-attested scopes).
   */
  readonly requiredScopes?: readonly string[] | undefined;
  /**
   * Stable session identifier. Set at construction (from the
   * `CreateSessionInput.sessionId` or generated by the parent App);
   * never changes. Adopters use this to discriminate sessions in
   * cross-session observation, route messages, and persist
   * session-scoped data.
   */
  readonly id: string;

  /**
   * What the session is doing right now — the live twin of the durable
   * `SessionRecord.status` a `list_sessions` row carries — read it to answer
   * "is this one busy?" without a store round trip.
   */
  readonly status: BridgeSessionStatus;

  /**
   * Primary entry point. Adds the supplied messages to the timeline
   * and runs ONE execution via the loop executor. Returns a handle
   * that is both an `AsyncIterable<ProtocolEvent>` (for streaming
   * observation) and carries a `.result: Promise<SendResult>` (for
   * the final outcome).
   *
   * @throws {SessionError}
   */
  send<T = unknown>(input: SendInput<P, T>): Promise<SessionExecutionHandle<T>>;

  /**
   * Cancel the session's CURRENT execution, if one is running. The
   * session-scoped twin of {@link SessionExecutionHandle.abort} — same
   * `reason`, same teardown — for a caller that holds the session but not the
   * handle: the `session/abort` wire verb, a supervisor, a UI that reconnected
   * after the `send` RPC's connection dropped.
   *
   * Idempotent and quiet: aborting an idle session is a no-op, and an
   * execution that finishes naturally while the abort is in flight is a
   * success. It cancels ONE execution — it does not refuse future sends (that
   * is `close()`, or the construction-bound signal).
   *
   * `{ cascade: true }` widens the SCOPE to the live spawn subtree — see
   * {@link SessionAbortOptions.cascade} and the cancellation ladder there.
   *
   * @throws {SessionError}
   */
  abort(reason?: string, opts?: SessionAbortOptions): Promise<void>;

  /**
   * Checkpoint — the flush barrier. Fans `persist(ctx)` out to every
   * {@link CheckpointCapable} bridge, so each flushes write-behind to its OWN
   * store; no value crosses the seam. Routed through the `session:snapshot`
   * command, minting `onBeforeSessionSnapshot` (veto) /
   * `onAfterSessionSnapshot`.
   *
   * A rejected `persist` rejects this call, so a failed flush is never
   * followed by the caller's unmount (checkpointing §3.2).
   *
   * @throws {SessionError}
   */
  snapshot(): Promise<void>;

  /**
   * Compile what a tick WOULD send, without sending it — the three artifacts
   * that exist on the way to the provider.
   *
   * ```ts
   * const { tree, input, request } = await session.dryRun();
   * ```
   *
   * Nothing reaches the provider, no timeline entry is written, and the tick
   * counter does not move. It is NOT side-effect free: rendering runs the tree,
   * so `useData` fetches and lifecycle hooks on the render path fire. For a
   * retrieval-backed agent that means a real query.
   *
   * The rungs are individually available ({@link compile}, {@link project},
   * {@link prepareRequest}) for when a later one cannot run — `compile` needs
   * no model, the other two do.
   *
   * @throws {SessionError} when no model is configured (the later rungs only).
   */
  dryRun(): Promise<SessionDryRunResult>;

  /** Rung 1 — the rendered IR. Needs no model. */
  compile(): Promise<RenderedTree>;

  /**
   * Rung 2 — the canonical input the MODEL sees, post-formatter. Pass a tree
   * from {@link compile} to reuse it; omit to render one.
   *
   * @throws {SessionError} when no model is configured.
   */
  project(tree?: RenderedTree): Promise<LanguageModelInput>;

  /**
   * Rung 3 — the provider-native request. `undefined` when the executor has no
   * provider adapter behind it, and it is the request BEFORE
   * `onBeforeModelProviderRequest` hooks run.
   *
   * @throws {SessionError} when no model is configured.
   */
  prepareRequest(input: LanguageModelInput): unknown;

  /**
   * Rehydrate this live session from its stores. Fans `hydrate(ctx)` out to
   * every {@link CheckpointCapable} bridge, each reading the latest for its own
   * session scope from its own store — the same fan-out genesis runs, so open,
   * resume-after-eviction, and explicit restore share ONE store-read path.
   * Routed through the `session:restore` command, minting
   * `onBeforeSessionRestore` / `onAfterSessionRestore`.
   *
   * @throws {SessionError}
   */
  restore(): Promise<void>;

  /**
   * Shut down. Future commands fail with `SessionClosedError`. Idempotent.
   *
   * Runs as the `session:close` command (ADR 92 Family 2 §5), symmetric with
   * `app:close-app` and `gateway:close` — so `onBeforeSessionClose` can hold
   * teardown open for a drain and the audit trail records the end of a session
   * the way it records the beginning. Close-op envelopes are BUS-ONLY per the
   * Operation framework's `JournalingPolicy.override`: the body reaches
   * substrate teardown, so a terminal appended afterwards could target a
   * journal an `onClose` handler already closed.
   *
   * `opts.reason` distinguishes a genuine session END from transparent PAGING
   * (`"evicted"` — the app's LRU / idle sweep releasing memory while the
   * durable record survives). It is provenance for the audit record only;
   * teardown is identical either way.
   */
  close(opts?: SessionCloseInput): Promise<void>;

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
   * The session's continuation decision (ADR 67). The loop calls this
   * once per tick — AFTER the compiler tick-end has settled the tree —
   * with the settled {@link TickResult}. The session folds its
   * continuation predicates into ONE {@link TickEndForwardDecision}:
   *
   *   - a trusted tree `stopAfterTick` request → **stop-force**
   *     (`{ kind: "stop" }`) — tier-1, beats everything;
   *   - an active/blocking gate, a tree `continueAfterTick`, or steering
   *     (new input mid-execution) → **continue-force**
   *     (`{ kind: "continue" }`) — holds the loop open;
   *   - otherwise `undefined` (abstain → the loop's own default).
   *
   * Precedence mirrors the loop's own resolution: stop-force >
   * continue-force > abstain, all under the `maxTicks` hard cap the loop
   * still enforces. Gate evaluation (arming / satisfied / fail-closed /
   * read-only) is driven here, not from the compiler mount.
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
   * **Lineage + teardown (SP4–SP6).** The child inherits the parent's
   * spawn `spawnPath` (extended with the parent's own id) — carried on the
   * child's `SessionRecord`, its execution-scope envelopes, and its handle
   * stream so sub-agent work is attributable. The parent's construction
   * signal fans into the child (parent abort → child in-flight teardown),
   * and a parent close/abort disposes the child (no leaked sub-sessions).
   *
   * @throws {SessionError} — `SessionClosedError` if the parent is
   *   shutting down; `SpawnDepthExceededError` if the parent's spawn depth
   *   is already at the `sessions.maxSpawnDepth` ceiling (fail-closed, SP4);
   *   impl-specific failures otherwise.
   */
  spawn(input: SpawnInput<P>): Promise<SessionExecutionHandle | SessionHarnessProtocol<P>>;

  /**
   * Fork this session into a same-image child with a full copy of its state.
   *
   * A fork is a {@link spawn} (no send) of the parent's OWN agent root —
   * `SpawnInput.agent` defaults to the parent's root — over a BRANCHED copy of
   * the parent's durable scopes: {@link snapshot} flushes, every
   * `BranchCapable` bridge copies the parent's scope onto the child's at its
   * own store layer, then {@link restore} opens the child on that copy. The
   * child gets its own `sessionId` and spawn lineage (`spawnPath`), and is
   * ALWAYS returned unbound — a fork never auto-sends; the caller drives it.
   *
   * Post-fork the two sessions diverge: a mutation on one (a knob set, a new
   * timeline entry) does NOT reflect on the other. This is the isolation
   * primitive `skills.run(name, { isolate: true })` routes through.
   *
   * @throws {SessionError} — `SessionClosedError` if the parent is shutting
   *   down; `SpawnDepthExceededError` at the spawn-depth ceiling; impl-specific
   *   failures otherwise.
   */
  fork(input?: ForkInput): Promise<SessionHarnessProtocol<P>>;

  /**
   * The model this session is about to call, and what is known about it —
   * resolved against the session's LIVE target with the full precedence fold
   * (adopter registry > the target's self-description > seed).
   *
   * This is the ground truth, and it is not the app's default: a session
   * changes model at runtime through `session:set-model`, a spawn override, or
   * a per-tick `<Model>`. It also answers before any turn has run, where
   * message provenance cannot.
   *
   * `undefined` when no model is bound (a model-less send) — a legal state.
   */
  modelInfo(): ModelInfoResult | undefined;

  /**
   * The session's tools handle — the curated projection of the tool registry
   * (three-audiences-plan §F). SYNC View reads (`list`/`get`/`has`), the
   * host-door `dispatch(name, input, opts?)` (`via: "dispatch"` — replaces the
   * removed `session.dispatch`), and the family topology-subscription pair.
   * Reads exactly like `session.knobs` / `session.state`.
   *
   * Power users who need the live `ToolDeclaration` (with its Standard-Schema
   * validator) keep the raw `session.toolExecutor`.
   */
  readonly tools: ToolsHandle;

  /**
   * Return a programmatic handle for a named channel. Each call
   * returns a new handle bound to the same name — handles are cheap
   * wrappers, not registered. Channel events flow on
   * `surface: "session"` with name `session:channel:<name>`.
   */
  channel<T = unknown>(name: string): ChannelHandle<T>;

  /**
   * Current snapshot of a channel as a ready-to-publish envelope, or
   * `undefined` if no provider owns `channel`.
   *
   * The session scans its bridges for the {@link ChannelSnapshotProvider}
   * that owns `channel` and renders its current state into a `delta`-phase
   * `ChannelEvent`. The `sub/subscribe` wire handler prepends this frame so
   * a fresh subscriber opens WITH the current state, then live deltas follow
   * on the same stream (the K8s `sendInitialEvents` / watch-list model).
   */
  channelSnapshot(channel: string): Promise<EventEnvelope | undefined>;

  /**
   * Register the session's escalation interceptor (ADR 69 T2a). This is
   * the value of a chain over a dumb pipe: an ancestor session can
   * **answer / deny / transform** a descendant's escalated request
   * instead of blindly forwarding it toward the client.
   *
   * The handler is consulted **first** on every escalation hop the
   * session receives — before the forward-or-terminal logic:
   *
   *   - returns `{ forward: false, response }` → **this hop answered**;
   *     the session short-circuits and threads `response` back to the
   *     origin (for `class: "elicit"`, `response` is an
   *     `ElicitationResult`). The parent / terminal never sees it.
   *   - **throws** → a hard **deny**; the throw propagates as the
   *     escalation `ask`'s rejection, so the origin's `ctx.elicit`
   *     rejects.
   *   - returns `{ forward: true }` → **fall through** to the existing
   *     forward (bubble one hop up) or terminal (root client) logic.
   *
   * ONE interceptor per session — the handler branches on
   * `payload.class` itself. Payload-agnostic: no policy DSL, no
   * class-typed sugar (ADR 69: "a handler is code; that's enough").
   * With NO interceptor registered, behavior is identical to a session
   * that simply forwards/resolves (T1 parity).
   *
   * Returns an {@link Unsubscribe} that clears the interceptor.
   *
   * @see docs/proposals/v2/blueprint/69-request-escalation.md
   */
  interceptEscalation(handler: EscalationInterceptor): Unsubscribe;

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
 * `deps` is OPTIONAL: a parent harness passes its substrate so the session's
 * events flow on the shared bus/journal, while a STANDALONE caller (a test, a
 * REPL, an adopter probing their callbacks before wiring an app) calls the
 * factory bare and gets a private local substrate. Same convention as
 * {@link ExecutorFactory}.
 *
 * Marker symbol `sessionHarnessFactory` disambiguates a factory from a
 * pre-constructed instance.
 */
export interface SessionHarnessFactory<P = unknown> {
  readonly sessionHarnessFactory: true;
  (deps?: SessionHarnessFactoryDeps): SessionHarnessProtocol<P>;
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
   * Child agent root. Defaults to the parent session's own agent root
   * (a same-image child). Opaque to the session boundary — forwarded to
   * the bound compiler at mount time. Same type contract as
   * `AppHarnessOptions.rootElement`.
   */
  readonly agent?: unknown;
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
  /**
   * The parent tool call this spawn is being made on behalf of — the
   * `ctx.toolCallId` of the handler that called `spawn()`. Surfaced as
   * `originCallId` on the parent stream's {@link SpawnStartEvent} so a
   * spawn-tree UI can attach the child to the SPECIFIC call that produced
   * it (the lineage `spawnPath` names sessions, not calls).
   *
   * Passed as DATA rather than derived ambiently: `spawn()` runs its
   * operation on a fresh fiber that cannot observe the dispatch's context
   * (the same Promise-boundary reason {@link SpawnContextChildInput.parentOpId}
   * is threaded explicitly). Omit for a host-driven spawn.
   */
  readonly originCallId?: string;
}

/**
 * Input for {@link SessionHarnessProtocol.fork}. A fork carries no agent
 * root (a fork is by definition a same-image child of its parent) and no
 * initial send (a fork is always returned unbound — the caller drives it).
 */
export interface ForkInput {
  /** Stable child session id. Generated if omitted. */
  readonly sessionId?: string;
  /** Caller metadata stored on the child's registry entry. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Override the parent's max tick bound for the forked child. */
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
  /**
   * Tear down a spawned child (SP6). Invoked by the parent when the parent
   * itself closes or its construction signal aborts — the child is a
   * parent-owned resource with no independent lifecycle, so it is disposed
   * (removed from the live registry + `session.close()`) rather than left
   * to leak. Idempotent; unknown / already-disposed ids are a no-op.
   */
  disposeChildSession(sessionId: string): Promise<void>;
  /**
   * Abort every live execution in the spawn subtree rooted at `sessionId` —
   * the subtree INCLUDING that session — deepest-first, and answer how many
   * sessions were aborted.
   *
   * The app owns this walk because the app owns the registry: a session knows
   * its children's IDS, but only the registry holds their harnesses, and only
   * the registry still finds a descendant whose intermediate ancestor was
   * evicted. This is the SAME walk `destroySession` runs as its first step,
   * exposed on its own so the weaker verb (`session.abort({ cascade: true })`)
   * can reuse it without any of destroy's teardown.
   *
   * Aborts only — no disposal, no store writes, no detached-task cancellation.
   */
  abortSubtree(sessionId: string, reason?: string): Promise<number>;
}

export interface SpawnContextChildInput<P = unknown> {
  readonly parentSessionId: string;
  readonly agent: unknown;
  readonly sessionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * The child's owning principal (ADR 48) — the parent's own `principal`,
   * threaded by `session.spawn()` so ownership descends the session tree.
   * Stamped onto the child's harness + `SessionRecord`. Ownership is not
   * caller-choosable: `SpawnInput` / `ForkInput` offer no principal override;
   * a child always inherits its parent's. Absent for a principal-less parent.
   */
  readonly principal?: string;
  readonly initialProps?: P;
  readonly initialKnobs?: Readonly<Record<string, unknown>>;
  readonly maxTicks?: number;
  /**
   * The child's spawn lineage (SP5) — the parent's own `spawnPath`
   * extended with the parent's session id, root-first. Its length is the
   * child's spawn depth. Stamped onto the child's `SessionRecord`,
   * execution-scope envelopes, and handle stream.
   */
  readonly spawnPath?: readonly string[];
  /**
   * The parent's construction signal (SP6), MERGED with the abort signal of
   * the parent execution that asked for the spawn (EX1). Fanned into the child
   * as its construction signal so both a parent abort and a
   * parent-EXECUTION abort tear down the child's in-flight work through the
   * same merge-into-execution-signal plumbing (PA1).
   */
  readonly signal?: AbortSignal;
  /**
   * The parent EXECUTION that spawned this child (EX1) — the id of the
   * execution running on the parent at the spawn site. Stamped on the child's
   * registry entry and its {@link SessionRecord}, which is what makes
   * `abortExecutionTree(executionId)` possible AFTER that execution settled:
   * the live-signal fan (see {@link signal}) covers the running case, and this
   * edge covers children that outlived the execution that made them.
   *
   * Absent when the spawn did not run inside an execution (a host calling
   * `session.spawn()` directly).
   */
  readonly originExecutionId?: string;
  /**
   * The parent TOOL CALL whose handler asked for the spawn, when there was one
   * (`SpawnInput.originCallId`). Travels alongside {@link originExecutionId} so
   * the durable record names the call that fanned out, not just the execution.
   */
  readonly originCallId?: string;
  /**
   * The invoking `session:command:spawn` operation's id (ADR 92 Family 2 §4) —
   * the causal link stamped as `parentOpId` on the `app:command:create-child-
   * session` operation, so the audit trail nests the child's creation under the
   * spawn that asked for it.
   *
   * Threaded as DATA rather than inherited from the fiber because the runtime's
   * ambient `parentOpId` derivation cannot cross the Promise boundary between
   * the parent's operation fiber and this call — a Promise continuation runs
   * outside the fiber and the `RuntimeContextRef` FiberRef is invisible there
   * (`runtime/src/substrate/runtime-context.ts`). Absent when the spawn did not
   * run under an operation.
   */
  readonly parentOpId?: string;
}

// Convenience re-exports for ergonomic imports.
export type { TerminalEvent };
