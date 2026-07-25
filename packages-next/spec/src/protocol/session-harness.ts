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
import type { EventEnvelope } from "../data/events.js";
import type { ContentBlock } from "../data/content-blocks.js";
import type { LanguageModelStopReason, UsageStats } from "../data/execution-result.js";
import type { TickResult } from "./loop-executor.js";
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
  /** The generation's usage — execution-produced assistant entries. */
  readonly usage?: import("../data/execution-result.js").UsageStats;
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
 * turn, attached as provenance; ticks never become entries. The
 * committed offset is derived by fold: input entries after the last
 * `outcome: "succeeded"` boundary are UNCONSUMED — they drive the
 * loop's continuation predicate and are retried after failures.
 * Always `visibility: "log"` semantics: never rendered to the model.
 */
export interface TurnBoundaryEntry {
  readonly kind: "boundary";
  readonly boundary: {
    readonly executionId: string;
    readonly outcome: "succeeded" | "failed" | "aborted";
    /** The TURN's aggregate usage — may exceed the entry-sum when a
     *  tick billed tokens but appended no assistant entry. */
    readonly usage?: import("../data/execution-result.js").UsageStats;
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
   * @see ToolBinding in `@agentick/spec-next` for the precedence ladder.
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
   * Delivery semantics for a send that RACES an in-flight execution
   * (ADR 53 §5 / queue-item 4b). Default `"steer"`.
   *
   *   - `"steer"` — inject into the CURRENTLY RUNNING execution. The
   *     messages are enqueued onto a per-execution steer queue and
   *     drained at the next tick boundary — after the tick's tool
   *     results apply, before the next render — so the model sees them
   *     on the NEXT tick of the SAME execution (no new execution, no
   *     settle wait; the call returns the in-flight handle). With NO
   *     execution running, degrades to a normal fresh send.
   *   - `"followUp"` — wait for the session to FULLY quiesce (the
   *     in-flight execution AND its durability barrier complete and the
   *     session returns to idle), THEN run as a NEW execution. With no
   *     execution running, identical to a normal send.
   *
   * The distinction only matters while an execution is in flight; both
   * modes behave identically on an idle session (fresh execution).
   */
  readonly delivery?: SendDelivery;
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
   * See "Observability" in `@agentick/runtime-next`'s README for the full model.
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
 * Delivery mode for {@link SendInput.delivery} (queue-item 4b). See that
 * field for the full semantics. `"steer"` is the default.
 */
export type SendDelivery = "steer" | "followUp";

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
  readonly usage: UsageStats;
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
  abort(reason?: string): Promise<void>;
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
 * narrow function keeps the skills package free of a `session-next` edge: it
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
 * exactly as {@link SnapshotCapable} is feature-detected for snapshot/restore.
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
 * {@link import("./hook-bridges.js").isSnapshotCapable}.
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
 * Read-only snapshot of session state. Returned by `snapshot()`; consumed
 * by `restore()`. Used by persistence backends + hibernate/restore.
 *
 * ## Generic bridge fold (ADR 27 — "Step 6")
 *
 * The session identity (`id` / `status` / `currentTick` / `usage` / …)
 * lives at the top level; **every serializable sub-harness state lives in
 * `bridges`**, keyed by bridge name. The session does NOT hardcode
 * `timeline`/`knobs` slots — it folds every {@link SnapshotCapable} bridge
 * generically (feature-detection via `isSnapshotCapable`), exactly as the
 * compiler harness folds `CompilerSnapshot.bridges`. A new SnapshotCapable
 * extension harness (sandbox, subscriptions, …) round-trips with ZERO
 * session changes.
 *
 *   - `bridges.timeline` → {@link TimelineHarnessSnapshot} (`.persisted` is
 *     the durable log, `.projection` the compacted view)
 *   - `bridges.knobs`    → the knob value map
 *   - `bridges.state`    → the K/V state map
 *   - `bridges.<ext>`    → any installed SnapshotCapable extension
 *
 * The single authoritative source per bridge avoids the divergence bug a
 * denormalized top-level copy would invite (a hook redacting `bridges.x`
 * but not a top-level `x`).
 */
export interface SessionSnapshot {
  readonly specVersion: string;
  readonly id: string;
  readonly parentSessionId?: string;
  readonly status: BridgeSessionStatus;
  readonly currentTick: number;
  /**
   * Per-bridge snapshot payloads, keyed by bridge name. Each value is the
   * `exportSnapshot()` output of a {@link SnapshotCapable} bridge. Typed
   * `unknown` because the set of bridges is open (module-augmented per
   * ADR 27); consumers narrow by name (e.g. `bridges.timeline as
   * TimelineHarnessSnapshot`).
   */
  readonly bridges: Readonly<Record<string, unknown>>;
  readonly usage: UsageStats;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Context handed to a {@link SnapshotMigration} — the version skew being
 * bridged. `from` is the snapshot's stored `specVersion`; `to` is the
 * running framework's `SPEC_VERSION`.
 */
export interface SnapshotMigrationContext {
  readonly from: string;
  readonly to: string;
}

/**
 * The snapshot-migration seam (recovery pass #1 — schema evolution).
 *
 * A typed callback invoked at the restore decision point when a snapshot's
 * `specVersion` differs from the running `SPEC_VERSION`. It returns a
 * snapshot in the CURRENT shape. Per the seam-over-setting rule this is a
 * callback at the decision point, NOT a config subsystem or a version
 * registry — the adopter owns any version-dispatch logic inside the
 * callback (chaining old→new internally if they support multiple skews).
 *
 * Construction-bound (`SessionHarnessOptions.migrateSnapshot`, threaded
 * from `AppHarnessOptions`): a given deployment knows how to bring old
 * snapshots up to its own shape. With none supplied, a version mismatch
 * throws `SnapshotVersionMismatch` (fail-closed — no silent stale apply).
 */
export type SnapshotMigration = (
  snapshot: SessionSnapshot,
  ctx: SnapshotMigrationContext,
) => SessionSnapshot | Promise<SessionSnapshot>;

/** Input to {@link SessionHarnessProtocol.restore}. */
export interface RestoreSnapshotInput {
  readonly snapshot: SessionSnapshot;
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
  SnapshotVersionMismatch,
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

// ============================================================================
// SessionHarnessProtocol — minimum 4e surface
// ============================================================================

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
   * Capture the current state as a serializable snapshot. Routed through
   * the `session:snapshot` command, so it mints `onBeforeSessionSnapshot`
   * (veto/observe) and `onAfterSessionSnapshot` (the v1 `onPersist`
   * "augment/redact the snapshot" parity — transform the output). Async so
   * the seam can await; the underlying bridge fold is synchronous.
   *
   * @throws {SessionError}
   */
  snapshot(): Promise<SessionSnapshot>;

  /**
   * Restore a previously captured {@link SessionSnapshot} into this live
   * session. Fans `importSnapshot()` out to every matching
   * {@link SnapshotCapable} bridge generically (ADR 27) and restores the
   * session accounting (tick + usage). Routed through the `session:restore`
   * command, minting `onBeforeSessionRestore` / `onAfterSessionRestore`.
   *
   * A snapshot whose `specVersion` differs from the framework's is run
   * through the construction-bound `migrateSnapshot` callback first; with
   * none supplied a mismatch throws `SnapshotVersionMismatch`.
   *
   * @throws {SessionError}
   */
  restore(input: RestoreSnapshotInput): Promise<void>;

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
   * `SpawnInput.agent` defaults to the parent's root — followed by a
   * {@link restore} of the parent's live {@link snapshot}. The child copies
   * every {@link SnapshotCapable} bridge's state (timeline, knobs, state,
   * gates), plus the tick + usage accounting, and gets its own `sessionId`
   * and spawn lineage (`spawnPath`). It is ALWAYS returned unbound — a fork
   * never auto-sends; the caller drives it.
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
}

export interface SpawnContextChildInput<P = unknown> {
  readonly parentSessionId: string;
  readonly agent: unknown;
  readonly sessionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
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
   * The parent's construction signal (SP6). Fanned into the child as its
   * construction signal so a parent abort tears down the child's in-flight
   * work through the same merge-into-execution-signal plumbing (PA1).
   */
  readonly signal?: AbortSignal;
}

// Convenience re-exports for ergonomic imports.
export type { TerminalEvent };
