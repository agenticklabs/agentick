/**
 * `LoopExecutorHarness` — reference implementation of
 * `LoopExecutorProtocol`.
 *
 * Inherits `BaseHarness<"loop">` for the full phase contract + FiberRef
 * scope + lazy delta emission. Implements the canonical tick loop:
 *
 *   1. compiler.renderTree(mountId) → RenderedTree
 *   2. executor.run(tree, target)     → ExecutorTerminal
 *   3. for each toolCall in terminal.result.toolCalls:
 *        toolExecutor.dispatch(...) → ToolDispatchResult
 *   4. stateApplicator.applyExecutorResult + applyToolResults
 *   5. the `loop:tick` command terminal settles (`onAfterLoopTick` runs
 *      in-cascade — the session's tick-end forwarder settles the tree +
 *      `useOnTickEnd` there, ADR 89 §4) THEN session.notifyTickEnd (the
 *      continuation decision) — ADR 67. The loop builds a typed
 *      `TickResult`, then folds the session's `TickEndForwardDecision`
 *      into its two-tier resolution (stop-force > continue-force >
 *      abstain), bounded by maxTicks.
 *   6. loop
 *
 * ## ADR 89 §3 — the tick is a command (`loop:tick`)
 *
 * Steps 1–4 are the body of a `loop:tick` command declared on THIS harness
 * (constructor `this.command`, reached in-fiber via `this.commandEffect` —
 * see {@link tickBody}). Wrapping the tick round mints `onBeforeLoopTick` /
 * `onAfterLoopTick` and emits phases like every other op. The DECIDE (the
 * continuation decision — notifyTickEnd fold / maxTicks) stays OUT of the
 * command, in the `run-execution` while-continuation: **settle is IN (an
 * in-cascade `onAfterLoopTick` hook), decide is OUT.** The command's
 * terminal IS the tick barrier the loop awaits — the next tick starts only
 * after this one settles.
 *
 * ADR-89 open question resolved: `loop:tick` lives on the LOOP harness (the
 * loop OWNS tick orchestration), NOT the model executor (which owns the single
 * model call, `model:generate` in ADR 89 §1).
 *
 * ## ADR 89 §4 — lifecycle is the projected command-hook system
 *
 * The loop feeds NO lifecycle store. The React `useOn*` hooks are a
 * projection the SESSION wires: forwarders on this harness's
 * `onBefore/AfterLoopRunExecution` + `onBefore/AfterLoopTick` hooks (and
 * the tool executor's `tool:dispatch`, the model executor's
 * `model:generate[_stream]`) route the command lifecycle into the
 * compiler's per-mount dispatch. The retired `notifyLifecycle` bridge —
 * the loop hand-feeding the compiler — is gone; the loop knows nothing
 * about the compiler's observation layer.
 *
 * ## ADR 77 — the fiber spine
 *
 * `runExecutionBody` is ONE `Effect.gen` fiber. Every downstream harness
 * call composes in-fiber via its `.fx` twin (`yield* compiler.fx
 * .renderTree(...)`, `executor.fx.run(...)`, `toolExecutor.fx.dispatch
 * (...)`, `stateApplicator.fx.apply*(...)`) — no `runPromise` root between
 * boundaries, so telemetry/interruption propagate through the whole tree.
 * The only Promise boundary is the session's `notifyTickEnd` callback
 * (no span) — awaited in-fiber via {@link awaitBridge} (a bare
 * `Effect.tryPromise`, NOT a severing `runHarnessProtocol` root). The
 * genuine external-I/O boundaries (`adapter.execute`, the user tool
 * handler) live INSIDE the executor / tool-executor, not here.
 *
 * Per-phase events on `surface: "loop"` give a single subscriber the
 * full execution flow without having to compose four other harnesses'
 * events.
 *
 * @see docs/proposals/v2/blueprint/05-loop-executor.md
 */

import { Effect, Either } from "effect";

import {
  BaseHarness,
  type Middleware,
  type StreamCommand,
  runHarnessProtocol,
  ulid,
} from "@agentick/runtime-next";
import type {
  ContentBlock,
  ExecutionRunResult,
  ExecutionTerminal,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelStopReason,
  LoopExecutionEvent,
  LoopExecutorError,
  LoopExecutorFx,
  LoopExecutorProtocol,
  LoopToolResult,
  MessageEnvelope,
  MessageHandlerError,
  EventBus,
  MessageInbox,
  OperationJournal,
  OutputSpec,
  RunExecutionInput,
  SpecConfig,
  TickInput,
  TickResult,
  ToolCall,
  ToolDeclaration,
  UsageStats,
} from "@agentick/spec-next";
import {
  ExecutionError,
  HandlerError,
  MultipleStructuredOutputs,
  NoModelForExecutionError,
  ProviderRejected,
  StructuredOutputIncomplete,
  TerminalToolNameCollision,
  toJsonSchema,
  toRegistration,
} from "@agentick/spec-next";
import { mergeAbortSignals } from "@agentick/utils-next";

// ADR 80/83 — light up the execution-lifecycle verb. `loop:run-execution`
// is a STREAMING command (`this.commandStream`, see the constructor): its
// chunks ARE the `LoopExecutionEvent`s the run produces. Typing it here mints
// `onBeforeLoopRunExecution` / `onAfterLoopRunExecution` (boundary hooks) AND
// — because the entry carries a `chunk` field — the per-chunk
// `onLoopRunExecutionChunk` interceptor (ADR 80 Phase 2), a free observe/
// transform tap over the execution event stream. Input is the execution
// request; output the settled `ExecutionTerminal`; chunk the event union.
// ADR 89 §3 — the per-tick round is `loop:tick`, a command on the LOOP
// harness (declared in the constructor via `this.command`, reached in-fiber
// via `this.commandEffect`). Typing it here mints `onBeforeLoopTick` (over
// `TickInput`) / `onAfterLoopTick` (over the settled `TickResult`). Input is
// the per-tick context (identity + live refs); output the settled tick
// outcome. Like `run-execution`, `TickInput` carries live object refs so the
// verb is `exposure: "internal"` (never inbox/wire-addressable).
declare module "@agentick/runtime-next" {
  interface CommandRegistry {
    "loop:run-execution": {
      input: RunExecutionInput;
      output: ExecutionTerminal;
      chunk: LoopExecutionEvent;
    };
    "loop:tick": { input: TickInput; output: TickResult };
  }
}

// ============================================================================
// Internal types
// ============================================================================

interface InFlightEntry {
  readonly executionId: string;
  /**
   * Per-execution abort controller (ADR 77 Stage 5 — structured
   * cancellation). `abort()` fires it; its signal is merged with the
   * caller's `input.signal` and threaded to the executor + tool dispatch,
   * so an in-flight model call / tool handler is torn down IMMEDIATELY
   * rather than at the next tick boundary. The executor turns the signal
   * into real Effect fiber interruption of the provider call.
   */
  readonly controller: AbortController;
  /**
   * Execution-timeout timer (Stage 5). Fires the controller + sets the
   * aborted map after `input.timeoutMs`; cleared on every exit via
   * `Effect.ensuring`. Absent when no timeout was requested.
   */
  readonly timer?: ReturnType<typeof setTimeout>;
  abortReason?: string;
}

interface MutableUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  ticks?: number;
}

interface TickAccumulator {
  ticks: number;
  output: ContentBlock[];
  toolResults: LoopToolResult[];
  usage: MutableUsage;
  lastStopReason?: LanguageModelStopReason;
}

function zeroUsage(): MutableUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

// ============================================================================
// LoopExecutorHarness
// ============================================================================

/**
 * Construction options for {@link LoopExecutorHarness}. Minimal today — the
 * loop takes its substrate positionally; this carries the ADR 76/83 resolved
 * interceptor snapshot (the app-shared spine folds the APP's layer here).
 */
export interface LoopExecutorHarnessOptions {
  /**
   * Resolved interceptor snapshot (ADR 76 tier 3 + ADR 83 amendment) — the
   * app's resolved interceptors (guards, `.use` transforms, AND declarative
   * `createApp({ hooks })` adapted to op-scoped middleware), folded in at
   * construction and forwarded to {@link BaseHarness}. Defaults to `[]`.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * LIVE interceptor parent (ADR 83 §4). The app passes `interceptorParent: this`
   * alongside the snapshot so a LATER `app.use()` / `app.guard()` / `app.hook()`
   * reaches this app-shared spine harness too. Forwarded to {@link BaseHarness}.
   */
  readonly interceptorParent?: BaseHarness;
}

export class LoopExecutorHarness extends BaseHarness<"loop"> implements LoopExecutorProtocol {
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly aborted = new Map<string, string | undefined>();

  /**
   * The `loop:run-execution` STREAMING command (`commandStream`, ADR 51 §2 +
   * ADR 77). Its chunks ARE the {@link LoopExecutionEvent}s the run produces;
   * the body emits through the threaded sink. The session consumes the `.fx`
   * sink-fold face (in-fiber); the drain-only Promise facade
   * ({@link runExecution}) is the `.run` face (no-op sink). `exposure:
   * "internal"` — `RunExecutionInput` carries live refs (ADR 51 §1.2).
   */
  private readonly runExecutionCmd: StreamCommand<
    RunExecutionInput,
    LoopExecutionEvent,
    ExecutionTerminal,
    LoopExecutorError | NoModelForExecutionError
  >;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: LoopExecutorHarnessOptions = {},
  ) {
    super("loop", scopeId, journal, bus, inbox, {
      inheritedInterceptors: options.inheritedInterceptors,
      interceptorParent: options.interceptorParent,
    });

    // ADR 89 §3 — the per-tick round as a declared command. ONE tick
    // iteration THROUGH SETTLE (render → model → tool → apply → tick-end);
    // its terminal IS the tick barrier the run-execution loop awaits. The
    // DECIDE (continuation policy) stays OUT, in the run-execution
    // while-loop. Declared here (like `run-execution`) so it mints
    // `onBeforeLoopTick`/`onAfterLoopTick` and emits phases like every op;
    // reached via `this.commandEffect` inside `runExecutionBody` so it runs
    // IN the run-execution fiber (ADR 77 one-fiber — parentOpId auto-threads,
    // kill/resume interruption propagates). `exposure: "internal"`:
    // `TickInput` carries LIVE refs (compiler/executor/tool/applicator +
    // the session's resolvers), so the verb is NOT inbox/wire-addressable
    // (ADR 51 §1.2). Deterministic opId keyed by the tick's `tickId`. The
    // returned Promise facade is unused — the loop composes the twin.
    this.command<TickInput, TickResult, unknown>({
      name: "loop:tick",
      exposure: "internal",
      opId: (i) => `loop:tick:${i.tickId}`,
      scope: (i) => ({
        sessionId: i.sessionId,
        executionId: i.executionId,
        tickId: i.tickId,
        // SP5 — sub-agent attribution: every tick envelope carries the
        // session's spawn lineage when it is a spawned child.
        ...(i.spawnPath !== undefined ? { spawnPath: i.spawnPath } : {}),
      }),
      handler: (i) => this.tickBody(i),
    });

    // ADR 51 §2 + ADR 77 — the execution as a STREAMING command. Its chunks
    // ARE the `LoopExecutionEvent`s; `runExecutionBody` emits through the
    // threaded `sink` where it used to call `input.onEvent?.(...)`. One
    // channel — the sink IS the event stream (no parallel push-callback).
    // Registered like `loop:tick` (`exposure: "internal"` — `RunExecutionInput`
    // carries live refs, ADR 51 §1.2), reached via the three `commandStream`
    // faces: the session composes `.fx` (sink-fold, in-fiber), the Promise
    // facade drains `.run` (no-op sink). The op name `loop:command:run-execution`
    // + opId `loop:execution:<id>` + scope are preserved byte-identically, so
    // the boundary hooks (`onBefore/AfterLoopRunExecution`) fire exactly as
    // before; the `chunk` field additionally mints `onLoopRunExecutionChunk`.
    this.runExecutionCmd = this.commandStream<
      RunExecutionInput,
      LoopExecutionEvent,
      ExecutionTerminal,
      LoopExecutorError | NoModelForExecutionError
    >({
      name: "loop:run-execution",
      exposure: "internal",
      opId: (i) => `loop:execution:${i.executionId}`,
      scope: (i) => ({
        sessionId: i.sessionId,
        executionId: i.executionId,
        // SP5 — every execution envelope from a spawned child carries its
        // spawn lineage so sub-agent work is attributable on the bus/journal.
        ...(i.spawnPath !== undefined ? { spawnPath: i.spawnPath } : {}),
      }),
      body: (i, sink) => this.runExecutionBody(i, sink),
    });
  }

  // ──────── LoopExecutorProtocol ────────

  /**
   * The Effect-canonical `.fx` surface (ADR 77, the dual-typed edge). The
   * session harness reaches `loop.fx.runExecution(input, sink)` to compose an
   * execution into one fiber tree (Stage 3) AND drain its events through
   * `sink`; the plain `loop.runExecution(...)` Promise below is the drain-only
   * facade (the `commandStream` `.run` face, no-op sink). Both drive the SAME
   * streaming command — `.fx` is the sink-fold twin, un-run.
   */
  get fx(): LoopExecutorFx {
    return {
      use: (mw) => this.registerEffectMiddleware(mw),
      runExecution: (input, sink) => this.runExecutionCmd.fx(input, sink),
    };
  }

  runExecution(input: RunExecutionInput): Promise<ExecutionTerminal> {
    return this.runExecutionCmd.run(input);
  }

  abort(input: { executionId: string; reason?: string }): Promise<void> {
    return runHarnessProtocol(
      Effect.sync(() => {
        const reason = input.reason ?? "aborted";
        this.aborted.set(input.executionId, reason);
        const entry = this.inFlight.get(input.executionId);
        if (entry) {
          entry.abortReason = reason;
          // Structured cancellation (Stage 5): fire the per-execution
          // controller so an IN-FLIGHT model call / tool handler tears
          // down now, not at the next tick-boundary check. Pre-run aborts
          // (no entry yet) still land via the `aborted` map's tick-top
          // check. Idempotent — a second abort on an already-aborted
          // controller is a no-op.
          entry.controller.abort(reason);
        }
      }),
    );
  }

  // ──────── inbox dispatch ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({ cause: new Error("loop executor inbox dispatch not yet wired") }),
    );
  }

  // ──────── internals ────────

  /**
   * The tick loop as ONE `Effect.gen` fiber (ADR 77). Every downstream
   * harness call composes in-fiber via its `.fx` twin — no `runPromise`
   * root between boundaries. The session's `notifyTickEnd` bridge callback
   * carries no span and is awaited via {@link awaitBridge}
   * (a bare `Effect.tryPromise`, in-fiber, NOT a severing root).
   * The imperative control flow (while / break /
   * accumulate) is unchanged from the Promise original — the characterization
   * suite pins it byte-identical. Any uncaught twin failure folds to
   * `ExecutionError` at the boundary (the two locally-handled failures —
   * a streaming `.result` reject and a hard tool-dispatch throw — are caught
   * in-body via `Effect.either`, exactly as the Promise version try/caught
   * them). `inFlight`/`aborted` cleanup rides `Effect.ensuring`.
   *
   * Streaming-up (ADR 51 §2): the body is the `commandStream` body, emitting
   * each {@link LoopExecutionEvent} through `sink` (in-fiber, in order) where
   * it used to call the retired `input.onEvent?.(...)`. The SAME `sink` is
   * threaded into each `loop:tick` via `TickInput.emit`, so the tick's own
   * events (`tick-start`, model deltas, tool-dispatch lifecycle) interleave in
   * emission order on the one channel.
   */
  private runExecutionBody(
    input: RunExecutionInput,
    sink: (event: LoopExecutionEvent) => Effect.Effect<void>,
  ): Effect.Effect<ExecutionTerminal, LoopExecutorError | NoModelForExecutionError, never> {
    const executionId = input.executionId;
    return Effect.gen(this, function* () {
      // Structured cancellation (Stage 5) — a per-execution controller
      // `abort()` fires. Merge it with the caller's `input.signal` into
      // ONE `execSignal` threaded to every in-flight edge (executor model
      // call + tool dispatch), so a mid-flight `abort()` tears the work
      // down immediately. The tick-top checks below still catch the
      // pre-run / between-tick cases off the `aborted` map + `input.signal`.
      const controller = new AbortController();
      // Optional execution timeout (Stage 5) — fires the SAME structured
      // abort path (controller + aborted map) so in-flight model/tool work
      // tears down and the terminal lands `canceled` with `stopReason:
      // "timeout"`. No default — the field is opt-in. Cleared on every exit.
      let timedOut = false;
      const timeoutTimer =
        input.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              this.aborted.set(executionId, "execution timeout");
              controller.abort("execution timeout");
            }, input.timeoutMs)
          : undefined;
      this.inFlight.set(executionId, {
        executionId,
        controller,
        ...(timeoutTimer !== undefined ? { timer: timeoutTimer } : {}),
      });
      if (this.aborted.has(executionId)) controller.abort(this.aborted.get(executionId));
      const execSignal = mergeAbortSignals(input.signal, controller.signal);

      const acc: TickAccumulator = {
        ticks: 0,
        output: [],
        toolResults: [],
        usage: zeroUsage(),
      };

      let stopReason:
        | LanguageModelStopReason
        | "max_ticks"
        | "aborted"
        | "vetoed"
        | "executor_failed"
        | "timeout"
        | "output_delivered" = "end";

      // §B2 structured-output run-level state. `terminalCapture` is lifted from
      // the tick that called the terminal tool onto the ExecutionRunResult;
      // `terminalStrategy` (last observed) decides whether a MISS warrants the
      // forced wrap-up tick.
      let terminalCapture: { readonly toolName: string; readonly input: unknown } | undefined;
      let terminalStrategy: "tool" | "responseFormat" | undefined;
      let terminalToolName: string | undefined;

      // Emit execution-start to the consumer (typed handle iterator).
      // The `useOnExecutionStart` lifecycle projection rides the
      // `loop:run-execution` command's own `onBeforeLoopRunExecution`
      // hook (ADR 89 §4) — the session's forwarder, not a loop feed.
      yield* sink({ kind: "execution-start", tick: 0 });
      const executionStartedAt = Date.now();

      // Default continuation policy: continue when the last tick
      // produced tool_use AND we have pending tool calls; stop
      // otherwise. Bounded by maxTicks. Subject to caller abort.
      while (acc.ticks < input.maxTicks) {
        // Cancellation check.
        if (this.aborted.has(executionId) || input.signal?.aborted) {
          stopReason = "aborted";
          break;
        }

        const tickId = `tick-${ulid()}`;
        acc.ticks += 1;
        const tickIndex = acc.ticks;
        const tickStartedAt = Date.now();

        // Assemble the per-tick command input — the per-tick identity
        // (`tickId`/`tickIndex`, the hook's clean first fields) plus the LIVE
        // refs, the session resolvers, and the MERGED `execSignal`. In-process
        // only (`loop:tick` is `exposure: "internal"`); the refs never cross
        // the wire, so this is NOT a wire-serializable command input.
        const tickInput: TickInput = {
          tickId,
          tickIndex,
          executionId,
          sessionId: input.sessionId,
          mountId: input.mountId,
          ...(input.spawnPath !== undefined ? { spawnPath: input.spawnPath } : {}),
          compiler: input.compiler,
          modelExecutor: input.modelExecutor,
          target: input.target,
          toolExecutor: input.toolExecutor,
          stateApplicator: input.stateApplicator,
          signal: execSignal,
          resolveRenderContext: input.resolveRenderContext,
          resolveModel: input.resolveModel,
          stream: input.stream,
          ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
          ...(input.outputSpec !== undefined ? { outputSpec: input.outputSpec } : {}),
          narrate: input.narrate,
          toolConcurrency: input.toolConcurrency,
          emit: sink,
        };

        // THE BARRIER (ADR 89 §3). Run the `loop:tick` command IN this fiber
        // and await its terminal. `commandEffect` composes the tick op in-fiber
        // (ADR 77 one-fiber: `parentOpId` auto-threads, kill/resume
        // interruption propagates), so the command terminal IS the tick barrier
        // the sequential `yield*` gave before. The command body runs the tick
        // THROUGH SETTLE (render → model → tool → apply → compiler tick-end);
        // `onBeforeLoopTick` fires on entry (over `TickInput`), `onAfterLoopTick`
        // on exit (over the settled `TickResult`). The DECIDE stays OUT (below).
        const tickResult = yield* this.commandEffect<TickInput, TickResult, unknown>(
          "loop:tick",
          tickInput,
        );

        // A model-executor failure returned a failed terminal WITHOUT settling
        // (the pre-command inline `break` before the tick-end bridge). Map the
        // outcome to the stop reason and break — the exact mapping the inline
        // code used (streaming `failed` and the general non-success terminal
        // both land `executor_failed`).
        const executorTerminal = tickResult.executorTerminal;
        if (executorTerminal.outcome !== "succeeded") {
          stopReason =
            executorTerminal.outcome === "canceled"
              ? "aborted"
              : executorTerminal.outcome === "vetoed"
                ? "vetoed"
                : "executor_failed";
          break;
        }

        // Accumulate this tick's contribution from the settled `TickResult`
        // (the tick command body no longer mutates the run's accumulator).
        const result = executorTerminal.result;
        accumulateUsage(acc.usage, result.usage);
        acc.output.push(...result.output);
        acc.toolResults.push(...tickResult.toolResults);
        acc.lastStopReason = result.stopReason;

        // §B2 — record the resolved strategy + any terminal capture from this
        // tick. Capture forces a STEER-PROOF stop below (a queued steer's
        // `continue` cannot override a delivered structured answer).
        if (tickResult.terminalStrategy !== undefined) {
          terminalStrategy = tickResult.terminalStrategy;
        }
        if (tickResult.terminalToolName !== undefined) {
          terminalToolName = tickResult.terminalToolName;
        }
        if (tickResult.terminalCapture !== undefined) {
          terminalCapture = tickResult.terminalCapture;
        }
        const terminalCaptured = terminalCapture !== undefined;

        // `provisionalContinue` is the loop's INTRINSIC disposition (tool_use
        // with pending calls → keep ticking), computed inside the tick body and
        // surfaced as `tickResult.shouldContinue`; the DECIDE reads it below.
        const provisionalContinue = tickResult.shouldContinue;

        // ADR 67 §"flip the tick-end order" — THEN DECIDE. The session
        // folds its continuation predicates (gates + steering + tree stop)
        // into ONE `TickEndForwardDecision`, reading the settled
        // `TickResult`. The loop's combination below is UNCHANGED — it
        // already implements the two-tier resolution (stop-force >
        // continue-force > abstain), with `maxTicks` as the tier-1 hard cap.
        // `notifyTickEnd` is a session-provided callback (no span) — awaited
        // in-fiber via the bridge.
        const forward = input.notifyTickEnd
          ? yield* awaitBridge(() =>
              input.notifyTickEnd!({
                sessionId: input.sessionId,
                executionId,
                tickId,
                outcome: "succeeded",
                result: tickResult,
              }),
            )
          : undefined;
        // §B2 steer-proof stop: a delivered structured answer terminates the
        // execution regardless of steering — `terminalCaptured` short-circuits
        // the fold so a forward `continue` cannot reopen the turn.
        const wantsContinue = terminalCaptured
          ? false
          : forward?.kind === "stop"
            ? false
            : provisionalContinue || forward?.kind === "continue";
        const tickStopReason: string = !wantsContinue
          ? result.stopReason
          : acc.ticks >= input.maxTicks
            ? "max_ticks"
            : "continue";
        const tickDuration = Date.now() - tickStartedAt;
        const shouldContinue = wantsContinue && acc.ticks < input.maxTicks;
        yield* sink({
          kind: "tick-end",
          tick: tickIndex,
          tickIndex,
          shouldContinue,
          stopReason: tickStopReason,
          usage: result.usage,
        });
        yield* sink({
          kind: "tick",
          tick: tickIndex,
          tickIndex,
          stopReason: tickStopReason,
          usage: result.usage ?? zeroUsage(),
          durationMs: tickDuration,
        });

        if (!wantsContinue) {
          // §B2 — a delivered structured output reports `output_delivered`, not
          // the provider's `tool_use`: the loop stopped on the delivery.
          stopReason = terminalCaptured ? "output_delivered" : result.stopReason;
          break;
        }

        // Loop continues. If we'd exceed maxTicks on next iteration,
        // emit the canonical max_ticks stop.
        if (acc.ticks >= input.maxTicks) {
          stopReason = "max_ticks";
          break;
        }
      }

      // If we exited the loop because of maxTicks reached at the top
      // of the next iteration (uncommon — the break inside catches
      // most cases), normalize the stop reason.
      if (acc.ticks >= input.maxTicks && acc.lastStopReason === "tool_use") {
        stopReason = "max_ticks";
      }

      // Stage 5 — a timeout fired the structured abort; label the stop
      // precisely. `wasAborted` (below) reads the map the timer set, so the
      // terminal is `canceled` with reason "execution timeout".
      if (timedOut) {
        stopReason = "timeout";
      }

      // §B2 enforcement rung — the forced wrap-up tick. A required terminal
      // tool (tool strategy) that went uncalled while the model finished
      // NATURALLY (not aborted / vetoed / executor-failed / timed out) gets ONE
      // more tick with `toolChoice: { tool: <terminal> }` — a HARD provider
      // guarantee that the model calls it, args provider-constrained to the
      // schema. At the maxTicks cap there is no room: skip the wrap-up and
      // reject. Still no call after the wrap-up (the provider guarantee should
      // prevent this) → the same typed miss error.
      if (
        terminalStrategy === "tool" &&
        terminalCapture === undefined &&
        terminalToolName !== undefined &&
        !this.aborted.has(executionId) &&
        !timedOut &&
        stopReason !== "executor_failed" &&
        stopReason !== "vetoed" &&
        stopReason !== "aborted" &&
        stopReason !== "timeout"
      ) {
        if (acc.ticks >= input.maxTicks) {
          return yield* Effect.fail(
            new StructuredOutputIncomplete({ toolName: terminalToolName, reason: "max_ticks" }),
          );
        }
        const wrapTickId = `tick-${ulid()}`;
        acc.ticks += 1;
        const wrapInput: TickInput = {
          tickId: wrapTickId,
          tickIndex: acc.ticks,
          executionId,
          sessionId: input.sessionId,
          mountId: input.mountId,
          ...(input.spawnPath !== undefined ? { spawnPath: input.spawnPath } : {}),
          compiler: input.compiler,
          modelExecutor: input.modelExecutor,
          target: input.target,
          toolExecutor: input.toolExecutor,
          stateApplicator: input.stateApplicator,
          signal: execSignal,
          resolveRenderContext: input.resolveRenderContext,
          resolveModel: input.resolveModel,
          stream: input.stream,
          ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
          ...(input.outputSpec !== undefined ? { outputSpec: input.outputSpec } : {}),
          toolChoice: { tool: terminalToolName },
          narrate: input.narrate,
          toolConcurrency: input.toolConcurrency,
          emit: sink,
        };
        const wrapResult = yield* this.commandEffect<TickInput, TickResult, unknown>(
          "loop:tick",
          wrapInput,
        );
        if (wrapResult.executorTerminal.outcome === "succeeded") {
          const wr = wrapResult.executorTerminal.result;
          accumulateUsage(acc.usage, wr.usage);
          acc.output.push(...wr.output);
          acc.toolResults.push(...wrapResult.toolResults);
          if (wrapResult.terminalCapture !== undefined) {
            terminalCapture = wrapResult.terminalCapture;
            // §B2 — the forced wrap-up delivered the output.
            stopReason = "output_delivered";
          }
        }
        if (terminalCapture === undefined) {
          return yield* Effect.fail(
            new StructuredOutputIncomplete({
              toolName: terminalToolName,
              reason: "no_terminal_call",
            }),
          );
        }
      }

      const runResult: ExecutionRunResult = {
        executionId,
        ticks: acc.ticks,
        usage: acc.usage,
        stopReason,
        output: acc.output,
        toolResults: acc.toolResults,
        // §B2 — the raw terminal capture (tool strategy). The SESSION validates
        // it against the retained `output` schema at result assembly.
        ...(terminalCapture !== undefined ? { terminalCapture } : {}),
      };

      const wasAborted = this.aborted.has(executionId);
      const terminal: ExecutionTerminal = wasAborted
        ? {
            outcome: "canceled",
            reason: this.aborted.get(executionId),
            result: runResult,
          }
        : { outcome: "succeeded", result: runResult };

      // Emit execution-end + execution summary events. The
      // `useOnExecutionEnd` projection rides `onAfterLoopRunExecution`
      // (ADR 89 §4) — the session's forwarder, not a loop feed.
      yield* sink({
        kind: "execution-end",
        tick: acc.ticks,
        stopReason,
        ...(wasAborted ? { aborted: true } : {}),
      });
      // execution summary
      void executionStartedAt;

      return terminal;
    }).pipe(
      // Any uncaught twin failure (renderTree / project / normalize / run /
      // replaceCompilerTools / apply* / a bridge reject) folds to
      // `ExecutionError` — the boundary the Promise original hit when an
      // un-try/caught `await` threw. The two locally-handled failures
      // (streaming `.result`, hard tool throw) are already absorbed in-body.
      Effect.catchAll(
        (cause): Effect.Effect<never, LoopExecutorError | NoModelForExecutionError> =>
          // `NoModelForExecutionError` (raised at the per-tick model resolution),
          // an already-`ExecutionError` cause, AND the §B2 structured-output
          // errors (collision / miss / multi-output — the session rejects the
          // send with the typed error) surface UNWRAPPED; every other uncaught
          // twin failure folds to `ExecutionError`.
          Effect.fail(
            cause instanceof ExecutionError ||
              cause instanceof NoModelForExecutionError ||
              cause instanceof TerminalToolNameCollision ||
              cause instanceof StructuredOutputIncomplete ||
              cause instanceof MultipleStructuredOutputs
              ? cause
              : new ExecutionError({ cause }),
          ),
      ),
      // inFlight/aborted cleanup on every exit (success, failure, interrupt)
      // — the Promise original's `finally`. Also clears the timeout timer
      // (Stage 5) so it can't fire after the execution settled.
      Effect.ensuring(
        Effect.sync(() => {
          const entry = this.inFlight.get(executionId);
          if (entry?.timer !== undefined) clearTimeout(entry.timer);
          this.inFlight.delete(executionId);
          this.aborted.delete(executionId);
        }),
      ),
    );
  }

  /**
   * The `loop:tick` command body (ADR 89 §3) — ONE tick iteration:
   * render → per-tick model resolve → execute (stream | run) → tool
   * dispatch → state apply → build `TickResult`. Returns the
   * {@link TickResult}; the run-execution continuation accumulates from it
   * and runs the ADR-67 DECIDE (continuation policy stays OUT of this
   * command — settle is IN, decide is OUT). The tick-end SETTLE (tree
   * settle + `useOnTickEnd` effects) is NOT a loop concern anymore
   * (ADR 89 §4): the session registers it as an in-cascade
   * `onAfterLoopTick` hook, which runs over the returned `TickResult`
   * BEFORE the command terminal resolves — so the barrier the old inline
   * settle provided is preserved by the hook cascade. On a model-executor
   * failure the body returns EARLY with a failed `executorTerminal` — the
   * continuation maps the outcome to a stop reason and breaks (the
   * session's forwarder skips the settle for non-succeeded terminals).
   *
   * Reached via `commandEffect` from {@link runExecutionBody}, so it stays in
   * the run-execution fiber (ADR 77 one-fiber) — `input.signal` (the merged
   * `execSignal`) interruption + `parentOpId` threading are preserved, and the
   * command terminal IS the tick barrier. Any uncaught twin failure rides the
   * command's `E` channel to the run-execution boundary's `Effect.catchAll`
   * (→ `ExecutionError`), as before.
   */
  private tickBody(input: TickInput): Effect.Effect<TickResult, unknown, never> {
    const { executionId, tickId, tickIndex } = input;
    const execSignal = input.signal;
    return Effect.gen(function* () {
      // Tick-start orchestration event (public stream). The
      // `useOnTickStart` projection rides `onBeforeLoopTick` (ADR 89 §4).
      yield* input.emit({ kind: "tick-start", tick: tickIndex, tickIndex });

      // Resolve THIS render's RenderContext envelope (ADR 55) — the
      // session's per-render fact producer (window today via
      // effectiveModelInfo; future: active model, budget, principal).
      // The loop is a dumb conduit — it threads the whole envelope into
      // renderTree below with no per-fact knowledge.
      const renderContext = input.resolveRenderContext?.();

      // 1. Render. The RenderContext envelope rides render-context
      // (ADR 54 / 55) so useContextInfo / useRenderContext read it
      // SYNCHRONOUSLY during this render — adaptive-compaction components
      // react before the IR freezes. Composed in-fiber via `.fx`.
      const renderResult = yield* input.compiler.fx.renderTree({
        mountId: input.mountId,
        sessionId: input.sessionId,
        executionId,
        ...(renderContext !== undefined ? { renderContext } : {}),
      });

      // ADR 56 — tree-declared per-tick model. If THIS render's IR
      // declared a model, resolve its ref (via the session-supplied
      // `resolveModel`, closing over the mount's ModelBridge) to the
      // run-ready RegisteredModel and run THAT model-executor + target for
      // this tick INSTEAD of input.modelExecutor/input.target. Absent, or a
      // ref that doesn't resolve, falls back to input.modelExecutor/target —
      // today's behavior, untouched. This IS the precedence: tick-IR >
      // send > session.
      //
      // TODO(adr-56-slice-1: adapter <Model> sugar) — the adopter face
      // (`<Model model={adapter}>` deriving {modelExecutor,target} from a
      // live model-next adapter, then calling useModelRegistration)
      // lands in a binding package that deps BOTH compiler-react +
      // model-next. Until then the ref is registered directly on the
      // ModelBridge. See ADR 56 §Deferred (1).
      // TODO(adr-56-slice-2: force-render activeModel) — reflecting the
      // IR-declared model back into the render-context `activeModel`
      // (ADR 55) needs render → resolve → re-render convergence. This
      // per-tick EXECUTION model resolves post-render (no chicken-and-
      // egg), so it is orthogonal to that slice. See ADR 56 §Deferred (2).
      const modelDecl = renderResult.tree.declarations?.model;
      const resolvedModel = modelDecl ? input.resolveModel?.(modelDecl.modelRef) : undefined;
      const tickModelExecutor = resolvedModel?.modelExecutor ?? input.modelExecutor;
      const tickTarget = resolvedModel?.target ?? input.target;
      // Execution-time model enforcement (the ONLY place a missing model is an
      // error). Model-less apps/sessions are legal — dispatch, snapshot, wire
      // plumbing all work without one. But a TICK must call a model: with the
      // full cascade (`per-tick <Model>` > `per-send` > `session default`)
      // resolved to nothing, THIS execution fails with a typed, unwrapped
      // `NoModelForExecutionError`. The app + session stay valid.
      if (tickModelExecutor === undefined || tickTarget === undefined) {
        return yield* Effect.fail(new NoModelForExecutionError());
      }
      // 2. Layered-tools compile (#138).
      //
      // The compiler emitted tool declarations in `renderResult.tree
      // .declarations.tools` (the IR's record of THIS render's
      // contribution). Sync that into the tool executor's registry
      // as the compiler-bound slice, then ask the registry for the
      // precedence-resolved model-visible set — the unification of
      // every layered seam (gateway/app/session/execution/extension/
      // compiler). The projection reads that set, not the IR slot.
      // Both compose in-fiber via `.fx`. Done BEFORE the config overlay
      // because the structured-output strategy resolution (§B2) reads
      // `modelTools.length` to resolve `"auto"`.
      const compilerTools = renderResult.tree.declarations?.tools ?? [];
      const compilerBinding = { scope: "compiler", mountId: input.mountId } as const;
      yield* input.toolExecutor.fx.replaceCompilerTools({
        mountId: input.mountId,
        registrations: compilerTools.map((d) => toRegistration(d, compilerBinding)),
      });
      const modelTools = yield* input.toolExecutor.fx.compileForTick({ exposure: "model" });

      // Structured-output resolution (three-audiences-plan §B2). Merge the
      // effective spec (send-level `input.outputSpec` wins over the tree-level
      // `<Output>` declaration), resolve `"auto"` against the model-visible
      // tool count, and — for the `"tool"` strategy — APPEND the synthetic
      // terminal tool at the TAIL of `modelTools` (after the cache-stable
      // prefix; the registry already tail-sorts execution bindings). A
      // collision with a model-exposed tool of the same name fails loud rather
      // than shadowing. The `"responseFormat"` strategy synthesizes a
      // json_schema directive folded into the config overlay below.
      const treeOutputs = renderResult.tree.declarations?.outputs ?? [];
      if (input.outputSpec === undefined && treeOutputs.length > 1) {
        return yield* Effect.fail(new MultipleStructuredOutputs({ count: treeOutputs.length }));
      }
      const outputSpec = input.outputSpec ?? outputSpecFromTree(treeOutputs);
      let terminalStrategy: "tool" | "responseFormat" | undefined;
      let modelToolsForRun: readonly ToolDeclaration[] = modelTools;
      let structuredResponseFormat: SpecConfig["responseFormat"] | undefined;
      if (outputSpec !== undefined) {
        terminalStrategy =
          outputSpec.strategy === "tool" || outputSpec.strategy === "responseFormat"
            ? outputSpec.strategy
            : modelTools.length > 0
              ? "tool"
              : "responseFormat";
        if (terminalStrategy === "tool") {
          if (modelTools.some((t) => t.name === outputSpec.toolName)) {
            return yield* Effect.fail(
              new TerminalToolNameCollision({ toolName: outputSpec.toolName }),
            );
          }
          modelToolsForRun = [...modelTools, terminalToolDeclaration(outputSpec)];
        } else {
          structuredResponseFormat = {
            type: "json_schema",
            name: outputSpec.toolName,
            schema: toJsonSchema(outputSpec.schema) as Record<string, unknown>,
          };
        }
      }

      // Per-tick config overlay. Layers fold OVER the render's `config`,
      // innermost-wins:
      //   1. `modelDecl.parameters` — a per-tick `<Model>`-declared
      //      generation-knob patch (temperature, maxOutputTokens, …), the
      //      same knobs RenderedTree.config carries and the executor reads
      //      via buildParameters.
      //   2. `input.responseFormat` — the SEND-level declarative directive
      //      (trail-response-format-send) OR (3) the `responseFormat`-strategy
      //      directive synthesized from `input.outputSpec` above. Spread LAST
      //      so an explicit send-level directive wins over tree/model config.
      //   4. `input.toolChoice` — the forced wrap-up tick's `{ tool }` (§B2).
      const configOverlay: Partial<SpecConfig> = {
        ...modelDecl?.parameters,
        ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
        ...(structuredResponseFormat !== undefined
          ? { responseFormat: structuredResponseFormat }
          : {}),
        ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
      };
      const tickCompiled =
        Object.keys(configOverlay).length > 0
          ? {
              ...renderResult.tree,
              config: {
                ...renderResult.tree.config,
                ...configOverlay,
              } as SpecConfig,
            }
          : renderResult.tree;

      // 2b. Provider-EXECUTED tools (Pass D). Unlike `modelTools`, these
      //     bypass the tool executor entirely — no `replaceCompilerTools`,
      //     no `compileForTick`, no precedence fold. The data is already in
      //     the IR: the compiler collected any tree-declared provider
      //     tools into `declarations.providerTools`, so we thread that slice
      //     straight to the executor's `project` phase. The projection
      //     (`buildProviderTools`) dedupes by provider+name, last-wins.
      //     TODO(pass-d): thread config-level provider tools
      //     (createApp/createSession `{ providerTools }`) once that config
      //     seam exists — this run threads ONLY the compiled-tree source, so
      //     a provider tool contributes iff a rendered tree declares it.
      const providerTools = tickCompiled.declarations?.providerTools ?? [];

      // 3. Execute. Streaming path (executeStream) when the caller
      //    requested streaming AND the executor supports it AND the
      //    target's capabilities don't explicitly disable it.
      const wantsStreaming =
        (input.stream ?? false) &&
        typeof tickModelExecutor.executeStream === "function" &&
        (tickTarget.capabilities?.supportsStreaming ?? true);

      let executorTerminal: ExecutorTerminal<LanguageModelExecutionResult>;

      if (wantsStreaming) {
        // Streaming path — project → executeStream(sink) → normalize,
        // all in ONE fiber (the sink-fold twin; no queue). The sink
        // forwards each AdapterDelta (including the symmetric summary
        // events) as a `model` event — NO loop-side synthesis on this
        // path (adapter already owns symmetric event emission).
        const projected = yield* tickModelExecutor.fx.project({
          compiled: tickCompiled,
          target: tickTarget,
          scope: { sessionId: input.sessionId, executionId, tickId },
          tools: modelToolsForRun,
          ...(providerTools.length > 0 ? { providerTools } : {}),
          ...(input.narrate !== undefined ? { narrate: input.narrate } : {}),
        });
        // #182 Option A: a provider failure lands on the twin's E
        // channel; `Effect.either` catches it exactly where the Promise
        // version caught the `.result` rejection → a failed terminal.
        const streamed = yield* Effect.either(
          tickModelExecutor.fx.executeStream(
            {
              targetInput: projected,
              target: tickTarget,
              scope: { sessionId: input.sessionId, executionId, tickId },
              signal: execSignal,
            },
            (delta) => input.emit({ kind: "model", tick: tickIndex, delta }),
          ),
        );
        if (Either.isLeft(streamed)) {
          // Model failure — return a failed terminal WITHOUT settling. The
          // continuation maps `failed` → `executor_failed` and breaks (the
          // pre-command inline `break` before the tick-end bridge).
          return failedTickResult(input, {
            outcome: "failed",
            error: new ProviderRejected({ cause: streamed.left }),
          });
        }
        const normalized = yield* tickModelExecutor.fx.normalize({
          targetOutput: streamed.right,
          target: tickTarget,
          scope: { sessionId: input.sessionId, executionId, tickId },
        });
        executorTerminal = { outcome: "succeeded", result: normalized };
      } else {
        // Non-streaming path: classic project → execute → normalize via run.
        executorTerminal = yield* tickModelExecutor.fx.run({
          compiled: tickCompiled,
          target: tickTarget,
          scope: { sessionId: input.sessionId, executionId, tickId },
          tools: modelToolsForRun,
          signal: execSignal,
          ...(providerTools.length > 0 ? { providerTools } : {}),
          ...(input.narrate !== undefined ? { narrate: input.narrate } : {}),
        });
      }

      if (executorTerminal.outcome !== "succeeded") {
        // Non-success terminal (canceled/vetoed/failed) — no settle; the
        // continuation maps the outcome to the stop reason and breaks.
        return failedTickResult(input, executorTerminal);
      }

      const result = executorTerminal.result;

      // Non-streaming path: synthesize summary model events from the
      // result so consumers subscribed to `message` / `content` /
      // `tool-call` events see the model's output. The streaming
      // path skips this — the adapter emitted them already.
      if (!wantsStreaming) {
        let blockIndex = 0;
        for (const block of result.output) {
          yield* input.emit({
            kind: "model",
            tick: tickIndex,
            delta: { type: "content", blockIndex, content: block },
          });
          blockIndex += 1;
        }
        for (const tc of result.toolCalls ?? []) {
          yield* input.emit({
            kind: "model",
            tick: tickIndex,
            delta: {
              type: "tool-call",
              callId: tc.id,
              name: tc.name,
              input: tc.input as Readonly<Record<string, unknown>>,
            },
          });
        }
        yield* input.emit({
          kind: "model",
          tick: tickIndex,
          delta: {
            type: "message-end",
            stopReason: result.stopReason,
            usage: result.usage ?? zeroUsage(),
          },
        });
      }

      // 3. Tool dispatch — every entry in result.toolCalls is a request
      // for Agentick to invoke (provider-side tools come back as
      // tool_result blocks in result.output and don't appear here). Each
      // dispatch composes in-fiber via `.fx`; a HARD throw lands on the
      // twin's E channel and `Effect.either` catches it into a failed
      // tool result (the run survives).
      //
      // Stage 5 — a tick's tool calls dispatch CONCURRENTLY
      // (`input.toolConcurrency`, default "unbounded"). `Effect.all`
      // preserves call-order in the results array regardless of
      // concurrency (so persistence + the model's next-tick view are
      // deterministic); only the per-tool lifecycle EVENTS interleave.
      // Abort / timeout tears down every in-flight tool fiber — each
      // carries `execSignal`, and `Effect.all` propagates interruption.
      //
      // §B2 sibling-calls-first: when the model calls the structured-output
      // terminal tool ALONGSIDE real tools in one tick, the real calls
      // dispatch normally (results captured), the terminal call is FILTERED
      // out of the dispatch set (it was never registered — dispatch would be a
      // ToolHandlerMissing error), its raw input is captured, and a synthesized
      // tool_result is emitted LAST so the persisted timeline pairs the
      // terminal tool_use. Detection is by name, from the resolved spec.
      const allToolCalls: readonly ToolCall[] = result.toolCalls ?? [];
      const terminalCall =
        terminalStrategy === "tool" && outputSpec !== undefined
          ? allToolCalls.find((tc) => tc.name === outputSpec.toolName)
          : undefined;
      const toolCalls: readonly ToolCall[] =
        terminalCall !== undefined
          ? allToolCalls.filter((tc) => tc !== terminalCall)
          : allToolCalls;
      const dispatchOne = (tc: ToolCall): Effect.Effect<LoopToolResult, never, never> =>
        Effect.gen(function* () {
          const startedAt = Date.now();
          // The `useOnToolStart` / `useOnToolEnd` projection (incl. the
          // eager model self-narration read) rides the tool executor's
          // OWN `tool:dispatch` command hooks (ADR 89 §4) — the
          // session's forwarder, not a loop feed.
          yield* input.emit({
            kind: "tool-dispatch-start",
            tick: tickIndex,
            callId: tc.id,
            name: tc.name,
            via: "model",
          });
          const dispatched = yield* Effect.either(
            input.toolExecutor.fx.dispatch({
              toolCallId: tc.id,
              name: tc.name,
              input: tc.input,
              context: {
                via: "model",
                sessionId: input.sessionId,
                executionId,
                tickId,
              },
              // Structured cancellation (Stage 5) — an in-flight tool
              // handler tears down when abort()/timeout fires (the tool
              // executor honors `DispatchInput.signal`).
              signal: execSignal,
            }),
          );
          if (Either.isRight(dispatched)) {
            const ok = dispatched.right;
            const durationMs = ok.durationMs ?? Date.now() - startedAt;
            // ADR 70 — `DispatchResult.succeeded` retired for `isError`
            // (soft/domain error). A resolved dispatch is a success unless
            // it flags a soft error; HARD failures reject (caught below).
            const dispatchSucceeded = ok.isError !== true;
            yield* input.emit({
              kind: "tool-dispatch-end",
              tick: tickIndex,
              callId: tc.id,
              name: tc.name,
              outcome: dispatchSucceeded ? "succeeded" : "failed",
              durationMs,
            });
            yield* input.emit({
              kind: "tool-dispatch",
              tick: tickIndex,
              callId: tc.id,
              name: tc.name,
              content: ok.content,
              succeeded: dispatchSucceeded,
              durationMs,
            });
            return {
              toolCallId: tc.id,
              toolName: tc.name,
              succeeded: dispatchSucceeded,
              content: ok.content,
              durationMs,
            };
          }
          const err = dispatched.left;
          const durationMs = Date.now() - startedAt;
          yield* input.emit({
            kind: "tool-dispatch-end",
            tick: tickIndex,
            callId: tc.id,
            name: tc.name,
            outcome: "failed",
            durationMs,
          });
          yield* input.emit({
            kind: "tool-dispatch",
            tick: tickIndex,
            callId: tc.id,
            name: tc.name,
            content: [],
            succeeded: false,
            durationMs,
            isError: true,
          });
          return {
            toolCallId: tc.id,
            toolName: tc.name,
            succeeded: false,
            content: [],
            durationMs,
            error: err,
          };
        });

      const dispatchedResults =
        toolCalls.length > 0
          ? yield* Effect.all(toolCalls.map(dispatchOne), {
              concurrency: input.toolConcurrency ?? "unbounded",
            })
          : [];
      const tickToolResults: LoopToolResult[] = [...dispatchedResults];

      // §B2 terminal capture — processed LAST (after sibling dispatch). Capture
      // the RAW input (the SESSION validates against the retained schema), and
      // synthesize a succeeded tool_result flowing the SAME apply path as real
      // results so the persisted timeline pairs the terminal tool_use — a
      // dangling tool_use with no tool_result breaks the next send on providers
      // that enforce pairing.
      let terminalCapture: { readonly toolName: string; readonly input: unknown } | undefined;
      if (terminalCall !== undefined && outputSpec !== undefined) {
        terminalCapture = { toolName: outputSpec.toolName, input: terminalCall.input };
        yield* input.emit({
          kind: "tool-dispatch",
          tick: tickIndex,
          callId: terminalCall.id,
          name: terminalCall.name,
          content: TERMINAL_RESULT_CONTENT,
          succeeded: true,
          durationMs: 0,
        });
        tickToolResults.push({
          toolCallId: terminalCall.id,
          toolName: terminalCall.name,
          succeeded: true,
          content: TERMINAL_RESULT_CONTENT,
          durationMs: 0,
        });
      }

      // 4. State application — the session harness's apply commands,
      // composed in-fiber via `.fx`. NoopStateApplicator records nothing;
      // the real session harness writes timeline entries here so the next
      // render sees them.
      yield* input.stateApplicator.fx.applyExecutorResult({
        sessionId: input.sessionId,
        executionId,
        tickId,
        result,
      });
      if (tickToolResults.length > 0) {
        yield* input.stateApplicator.fx.applyToolResults({
          sessionId: input.sessionId,
          executionId,
          tickId,
          results: tickToolResults,
        });
      }

      // 5. Build the typed `TickResult` (ADR 67). `provisionalContinue` is
      // the loop's INTRINSIC default disposition (tool_use with pending
      // calls → keep ticking), computed BEFORE the session's predicates run
      // (in the DECIDE, OUTSIDE this command). It rides the `TickResult` as
      // `shouldContinue` so a gate/steering predicate can read "would the
      // loop otherwise stop?" and hold it open.
      const provisionalContinue = result.stopReason === "tool_use" && tickToolResults.length > 0;
      const tickResult: TickResult = {
        executionId,
        sessionId: input.sessionId,
        tickId,
        tickIndex,
        executorTerminal,
        toolResults: tickToolResults,
        shouldContinue: provisionalContinue,
        stopReason: result.stopReason,
        // §B2 — surface the resolved strategy (so the run-execution
        // continuation can decide the forced wrap-up tick), the resolved
        // terminal tool name (for the wrap-up `toolChoice`), and the raw
        // terminal capture (lifted onto the ExecutionRunResult + forcing a
        // steer-proof stop).
        ...(terminalStrategy !== undefined ? { terminalStrategy } : {}),
        ...(terminalStrategy === "tool" && outputSpec !== undefined
          ? { terminalToolName: outputSpec.toolName }
          : {}),
        ...(terminalCapture !== undefined ? { terminalCapture } : {}),
      };

      // ADR 67 §"flip the tick-end order" — the SETTLE now rides the
      // command cascade (ADR 89 §4): the session's `onAfterLoopTick`
      // forwarder dispatches the tick-end lifecycle event (tree settle +
      // `useOnTickEnd` effects) over this returned `TickResult`, AWAITED
      // in-cascade BEFORE the command terminal resolves — so the DECIDE
      // (run in the run-execution continuation, after the terminal) still
      // reads SETTLED state. Settle IN (the hook), decide OUT.
      return tickResult;
    });
  }
}

// ============================================================================
// helpers
// ============================================================================

/**
 * Default terminal-tool instruction (§B2). The tool IS the instruction — its
 * presence in the tick's tool list is the "when the task is complete, call
 * this with the final answer" context (per-execution because the binding is
 * per-execution). Overridable on the output spec (`description`).
 */
const DEFAULT_TERMINAL_DESCRIPTION =
  "When the task is complete, call this tool with the final result. Its " +
  "arguments ARE the required answer shape — provide the final answer here " +
  "rather than as prose.";

/**
 * Synthesized content for the terminal tool's `tool_result` (§B2). The call is
 * the completion event; there is no handler to run, so the result is a fixed
 * acknowledgement that pairs the tool_use in the persisted timeline.
 */
const TERMINAL_RESULT_CONTENT: readonly ContentBlock[] = [
  { type: "text", text: "Result recorded." },
];

/**
 * The synthetic structured-output terminal tool (§B2). Its `inputSchema` IS
 * the output schema. NEVER registered (no `handlerRef` — the spec firewall,
 * and dispatch of an unregistered handler is a ToolHandlerMissing error): the
 * LOOP appends it to the model-facing tools list and filters its call out of
 * the dispatch set.
 */
function terminalToolDeclaration(spec: OutputSpec): ToolDeclaration {
  return {
    id: spec.toolName,
    name: spec.toolName,
    description: spec.description ?? DEFAULT_TERMINAL_DESCRIPTION,
    inputSchema: spec.schema,
    exposure: ["model"],
  };
}

/**
 * Derive an {@link OutputSpec} from the tree-level `<Output>` declaration
 * (§B2) — the first entry (multi-output is rejected upstream). Returns
 * undefined when the tree declares no output, or an output with no schema
 * (nothing to extract).
 */
function outputSpecFromTree(
  outputs: readonly import("@agentick/spec-next").OutputDeclaration[],
): OutputSpec | undefined {
  const decl = outputs[0];
  if (decl?.schema === undefined) return undefined;
  return {
    toolName: decl.name ?? "submit_result",
    ...(decl.description !== undefined ? { description: decl.description } : {}),
    schema: decl.schema,
    strategy: decl.strategy ?? "auto",
  };
}

/**
 * Build a `TickResult` for a tick whose model executor did NOT succeed
 * (failed / canceled / vetoed). `toolResults` is empty and
 * `shouldContinue` false; the session's tick-end forwarder skips the
 * settle for non-succeeded terminals (ADR 89 §4). The run-execution
 * continuation reads `executorTerminal.outcome`, maps it to the stop
 * reason, and breaks — byte-identical to the pre-command inline `break`
 * on a non-success terminal.
 */
function failedTickResult(
  input: TickInput,
  executorTerminal: ExecutorTerminal<LanguageModelExecutionResult>,
): TickResult {
  return {
    executionId: input.executionId,
    sessionId: input.sessionId,
    tickId: input.tickId,
    tickIndex: input.tickIndex,
    executorTerminal,
    toolResults: [],
    shouldContinue: false,
  };
}

/**
 * Await the session's `notifyTickEnd` bridge callback in-fiber. It
 * carries no span and is bare `async` (no `runHarnessProtocol` root), so
 * `Effect.tryPromise` composes it WITHOUT severing the fiber — the right
 * tool for an external, non-twin promise boundary. A rejection lands on
 * the `E` channel, folding to `ExecutionError` at the loop boundary (the
 * Promise original's "an un-caught awaited throw fails the run"). NOT
 * `Effect.promise` — that turns a reject into a defect that would bypass
 * the boundary's catch.
 */
function awaitBridge<A>(thunk: () => Promise<A> | A): Effect.Effect<A, unknown, never> {
  return Effect.tryPromise({ try: async () => thunk(), catch: (e: unknown) => e });
}

/**
 * Merge the caller's optional `input.signal` with the per-execution
 * abort controller's signal into ONE composite (Stage 5 — structured
 * cancellation). The composite aborts when EITHER source fires; the
 * loop threads it to every in-flight edge so a `loop.abort()` OR an
 * external `input.signal` abort tears down the in-flight model call /
 * tool handler. Same pattern as the executor's `mergeSignals` (kept
 * local to avoid a runtime dep on the executor package for one helper).
 */
function accumulateUsage(acc: MutableUsage, add?: UsageStats): void {
  if (!add) return;
  acc.inputTokens += add.inputTokens ?? 0;
  acc.outputTokens += add.outputTokens ?? 0;
  acc.totalTokens += add.totalTokens ?? 0;
  if (add.reasoningTokens !== undefined) {
    acc.reasoningTokens = (acc.reasoningTokens ?? 0) + add.reasoningTokens;
  }
  if (add.cachedInputTokens !== undefined) {
    acc.cachedInputTokens = (acc.cachedInputTokens ?? 0) + add.cachedInputTokens;
  }
  if (add.cacheCreationTokens !== undefined) {
    acc.cacheCreationTokens = (acc.cacheCreationTokens ?? 0) + add.cacheCreationTokens;
  }
}
