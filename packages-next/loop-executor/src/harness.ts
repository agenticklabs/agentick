/**
 * `LoopExecutorHarness` — reference implementation of
 * `LoopExecutorProtocol`.
 *
 * Inherits `BaseHarness<"loop">` for the full phase contract + FiberRef
 * scope + lazy delta emission. Implements the canonical tick loop:
 *
 *   1. reconciler.renderTree(mountId) → RenderedTree
 *   2. executor.run(tree, target)     → ExecutorTerminal
 *   3. for each toolCall in terminal.result.toolCalls:
 *        toolExecutor.dispatch(...) → ToolDispatchResult
 *   4. stateApplicator.applyExecutorResult + applyToolResults
 *   5. reconciler.notifyLifecycle (settle the tree + `useOnTickEnd`) THEN
 *      session.notifyTickEnd (the continuation decision) — ADR 67. The
 *      loop builds a typed `TickResult`, settles the tree, then folds the
 *      session's `TickEndForwardDecision` into its two-tier resolution
 *      (stop-force > continue-force > abstain), bounded by maxTicks.
 *   6. loop
 *
 * ## ADR 77 — the fiber spine
 *
 * `runExecutionBody` is ONE `Effect.gen` fiber. Every downstream harness
 * call composes in-fiber via its `.fx` twin (`yield* reconciler.fx
 * .renderTree(...)`, `executor.fx.run(...)`, `toolExecutor.fx.dispatch
 * (...)`, `stateApplicator.fx.apply*(...)`) — no `runPromise` root between
 * boundaries, so telemetry/interruption propagate through the whole tree.
 * The only Promise boundaries are the bridge NOTIFICATIONS that carry no
 * span (`reconciler.notifyLifecycle`, `session.notifyTickEnd`) — awaited
 * in-fiber via {@link awaitBridge} (a bare `Effect.tryPromise`, NOT a
 * severing `runHarnessProtocol` root) or dispatched fire-and-forget. The
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

import { BaseHarness, type Middleware, runHarnessProtocol, ulid } from "@agentick/runtime-next";
import type {
  ContentBlock,
  ExecutionRunResult,
  ExecutionTerminal,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelStopReason,
  LoopExecutorError,
  LoopExecutorFx,
  LoopExecutorProtocol,
  LoopToolResult,
  MessageEnvelope,
  MessageHandlerError,
  Operation,
  EventBus,
  MessageInbox,
  OperationJournal,
  RunExecutionInput,
  SpecConfig,
  SubstrateError,
  TickResult,
  ToolCall,
  UsageStats,
} from "@agentick/spec-next";
import {
  ExecutionError,
  HandlerError,
  ProviderRejected,
  toRegistration,
} from "@agentick/spec-next";

// ADR 80/83 — light up the execution-lifecycle verb. `loop:run-execution`
// (op `loop:command:run-execution`) already routes through `runOperation`
// (see `runExecutionFx`), so typing it here mints `onBeforeLoopRunExecution`
// / `onAfterLoopRunExecution` on the derived `CommandHooks` surface. Input is
// the execution request; output the settled `ExecutionTerminal` — the exact
// generics of the `runExecutionFx` Operation below.
declare module "@agentick/runtime-next" {
  interface CommandRegistry {
    "loop:run-execution": { input: RunExecutionInput; output: ExecutionTerminal };
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
  }

  // ──────── LoopExecutorProtocol ────────

  /**
   * The Effect-canonical `.fx` surface (ADR 77, the dual-typed edge). The
   * session harness reaches `loop.fx.runExecution(...)` to compose an
   * execution into one fiber tree (Stage 3); the plain
   * `loop.runExecution(...)` Promise below is the derived facade
   * (`runHarnessProtocol` at the boundary). Both drive the SAME Operation
   * — `fx.runExecution` is `runExecution` minus the terminal `runPromise`.
   */
  get fx(): LoopExecutorFx {
    return {
      use: (mw) => this.registerEffectMiddleware(mw),
      runExecution: (input) => this.runExecutionFx(input),
    };
  }

  /**
   * The composable `runExecution` Effect the harness builds — the
   * `.fx.runExecution` twin. Constructs the Operation and returns
   * `runOperation(op, body)` un-run, so an in-process caller stays in one
   * fiber. {@link runExecution} is the facade.
   *
   * ADR 51 classification: NOT a declarable command — the input carries
   * live object refs (reconciler, executor, toolExecutor, stateApplicator
   * callbacks, onEvent) and is in-process-only by doctrine (§1.2). The
   * addressable execution surface is the session's (see session harness
   * TODO(adr-51-session-verbs)).
   */
  private runExecutionFx(
    input: RunExecutionInput,
  ): Effect.Effect<ExecutionTerminal, LoopExecutorError | SubstrateError, never> {
    const op: Operation<RunExecutionInput, ExecutionTerminal, LoopExecutorError> = {
      opId: `loop:execution:${input.executionId}`,
      surface: "loop",
      name: "loop:command:run-execution",
      scope: {
        sessionId: input.sessionId,
        executionId: input.executionId,
      },
      input,
    };
    return this.runOperation(op, (i) => this.runExecutionBody(i));
  }

  runExecution(input: RunExecutionInput): Promise<ExecutionTerminal> {
    return runHarnessProtocol(this.runExecutionFx(input));
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
   * root between boundaries. Bridge notifications (`notifyLifecycle` /
   * `notifyTickEnd`) carry no span and are awaited via {@link awaitBridge}
   * (a bare `Effect.tryPromise`, in-fiber, NOT a severing root) or
   * dispatched fire-and-forget. The imperative control flow (while / break /
   * accumulate) is unchanged from the Promise original — the characterization
   * suite pins it byte-identical. Any uncaught twin failure folds to
   * `ExecutionError` at the boundary (the two locally-handled failures —
   * a streaming `.result` reject and a hard tool-dispatch throw — are caught
   * in-body via `Effect.either`, exactly as the Promise version try/caught
   * them). `inFlight`/`aborted` cleanup rides `Effect.ensuring`.
   */
  private runExecutionBody(
    input: RunExecutionInput,
  ): Effect.Effect<ExecutionTerminal, LoopExecutorError, never> {
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
        | "timeout" = "end";

      // Emit execution-start to consumer (typed handle iterator) AND
      // bridge it to the reconciler hook store (ADR 55) so
      // useOnExecutionStart fires. Fire-and-forget — a hook throw must
      // never fail the run (the store isolates per-listener throws).
      input.onEvent?.({ kind: "execution-start", tick: 0 });
      void input.reconciler.notifyLifecycle({
        mountId: input.mountId,
        event: { kind: "execution-start", executionId },
      });
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

        // Tick-start orchestration event (public stream).
        input.onEvent?.({ kind: "tick-start", tick: tickIndex, tickIndex });

        // Resolve THIS render's RenderContext envelope (ADR 55) — the
        // session's per-render fact producer (window today via
        // effectiveModelInfo; future: active model, budget, principal).
        // The loop is a dumb conduit — it threads the whole envelope into
        // renderTree below with no per-fact knowledge.
        const renderContext = input.resolveRenderContext?.();

        // Lifecycle bridge (#206) — dispatch tick-start to the reconciler
        // hook store AWAITED, BEFORE render. Without this bridge the
        // entire useOn* family is inert (no producer). A throw here fails
        // the run (→ ExecutionError) — pinned by characterization.
        yield* awaitBridge(() =>
          input.reconciler.notifyLifecycle({
            mountId: input.mountId,
            event: { kind: "tick-start", tickId, executionId },
          }),
        );

        // 1. Render. The RenderContext envelope rides render-context
        // (ADR 54 / 55) so useContextInfo / useRenderContext read it
        // SYNCHRONOUSLY during this render — adaptive-compaction components
        // react before the IR freezes. Composed in-fiber via `.fx`.
        const renderResult = yield* input.reconciler.fx.renderTree({
          mountId: input.mountId,
          sessionId: input.sessionId,
          executionId,
          ...(renderContext !== undefined ? { renderContext } : {}),
        });

        // ADR 56 — tree-declared per-tick model. If THIS render's IR
        // declared a model, resolve its ref (via the session-supplied
        // `resolveModel`, closing over the mount's ModelBridge) to the
        // run-ready RegisteredModel and run THAT executor + target for
        // this tick INSTEAD of input.executor/input.target. Absent, or a
        // ref that doesn't resolve, falls back to input.executor/target —
        // today's behavior, untouched. This IS the precedence: tick-IR >
        // send > session.
        //
        // TODO(adr-56-slice-1: adapter <Model> sugar) — the adopter face
        // (`<Model model={adapter}>` deriving {executor,target} from a
        // live model-next adapter, then calling useModelRegistration)
        // lands in a binding package that deps BOTH reconciler-react +
        // model-next. Until then the ref is registered directly on the
        // ModelBridge. See ADR 56 §Deferred (1).
        // TODO(adr-56-slice-2: force-render activeModel) — reflecting the
        // IR-declared model back into the render-context `activeModel`
        // (ADR 55) needs render → resolve → re-render convergence. This
        // per-tick EXECUTION model resolves post-render (no chicken-and-
        // egg), so it is orthogonal to that slice. See ADR 56 §Deferred (2).
        const modelDecl = renderResult.tree.declarations?.model;
        const resolvedModel = modelDecl ? input.resolveModel?.(modelDecl.modelRef) : undefined;
        const tickExecutor = resolvedModel?.executor ?? input.executor;
        const tickTarget = resolvedModel?.target ?? input.target;
        // `decl.parameters` overlay the compiled tree's generation config
        // for this tick (temperature, maxOutputTokens, …) — the same
        // knobs RenderedTree.config carries and the executor reads via
        // buildParameters. Merge IR params over the render's config.
        const tickCompiled =
          modelDecl?.parameters !== undefined
            ? {
                ...renderResult.tree,
                config: {
                  ...renderResult.tree.config,
                  ...modelDecl.parameters,
                } as SpecConfig,
              }
            : renderResult.tree;

        // 2. Layered-tools compile (#138).
        //
        // The reconciler emitted tool declarations in `renderResult.tree
        // .declarations.tools` (the IR's record of THIS render's
        // contribution). Sync that into the tool executor's registry
        // as the reconciler-bound slice, then ask the registry for the
        // precedence-resolved model-visible set — the unification of
        // every layered seam (gateway/app/session/execution/extension/
        // reconciler). The projection reads that set, not the IR slot.
        // Both compose in-fiber via `.fx`.
        const reconcilerTools = renderResult.tree.declarations?.tools ?? [];
        const reconcilerBinding = { scope: "reconciler", mountId: input.mountId } as const;
        yield* input.toolExecutor.fx.replaceReconcilerTools({
          mountId: input.mountId,
          registrations: reconcilerTools.map((d) => toRegistration(d, reconcilerBinding)),
        });
        const modelTools = yield* input.toolExecutor.fx.compileForTick({ exposure: "model" });

        // 3. Execute. Streaming path (executeStream) when the caller
        //    requested streaming AND the executor supports it AND the
        //    target's capabilities don't explicitly disable it.
        const wantsStreaming =
          (input.stream ?? false) &&
          typeof tickExecutor.executeStream === "function" &&
          (tickTarget.capabilities?.supportsStreaming ?? true);

        let executorTerminal: ExecutorTerminal<LanguageModelExecutionResult>;

        if (wantsStreaming) {
          // Streaming path — project → executeStream(sink) → normalize,
          // all in ONE fiber (the sink-fold twin; no queue). The sink
          // forwards each AdapterDelta (including the symmetric summary
          // events) as a `model` event — NO loop-side synthesis on this
          // path (adapter already owns symmetric event emission).
          const projected = yield* tickExecutor.fx.project({
            compiled: tickCompiled,
            target: tickTarget,
            scope: { sessionId: input.sessionId, executionId, tickId },
            tools: modelTools,
          });
          // #182 Option A: a provider failure lands on the twin's E
          // channel; `Effect.either` catches it exactly where the Promise
          // version caught the `.result` rejection → a failed terminal.
          const streamed = yield* Effect.either(
            tickExecutor.fx.executeStream(
              {
                targetInput: projected,
                target: tickTarget,
                scope: { sessionId: input.sessionId, executionId, tickId },
                signal: execSignal,
              },
              (delta) =>
                Effect.sync(() => input.onEvent?.({ kind: "model", tick: tickIndex, delta })),
            ),
          );
          if (Either.isLeft(streamed)) {
            executorTerminal = {
              outcome: "failed",
              error: new ProviderRejected({ cause: streamed.left }),
            };
            stopReason = "executor_failed";
            break;
          }
          const normalized = yield* tickExecutor.fx.normalize({
            targetOutput: streamed.right,
            target: tickTarget,
            scope: { sessionId: input.sessionId, executionId, tickId },
          });
          executorTerminal = { outcome: "succeeded", result: normalized };
        } else {
          // Non-streaming path: classic project → execute → normalize via run.
          executorTerminal = yield* tickExecutor.fx.run({
            compiled: tickCompiled,
            target: tickTarget,
            scope: { sessionId: input.sessionId, executionId, tickId },
            tools: modelTools,
            signal: execSignal,
          });
        }

        if (executorTerminal.outcome !== "succeeded") {
          stopReason =
            executorTerminal.outcome === "canceled"
              ? "aborted"
              : executorTerminal.outcome === "vetoed"
                ? "vetoed"
                : "executor_failed";
          break;
        }

        const result = executorTerminal.result;
        accumulateUsage(acc.usage, result.usage);
        acc.output.push(...result.output);

        // Non-streaming path: synthesize summary model events from the
        // result so consumers subscribed to `message` / `content` /
        // `tool-call` events see the model's output. The streaming
        // path skips this — the adapter emitted them already.
        if (!wantsStreaming && input.onEvent) {
          let blockIndex = 0;
          for (const block of result.output) {
            input.onEvent({
              kind: "model",
              tick: tickIndex,
              delta: { type: "content", blockIndex, content: block },
            });
            blockIndex += 1;
          }
          for (const tc of result.toolCalls ?? []) {
            input.onEvent({
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
          input.onEvent({
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
        const toolCalls: readonly ToolCall[] = result.toolCalls ?? [];
        const dispatchOne = (tc: ToolCall): Effect.Effect<LoopToolResult, never, never> =>
          Effect.gen(function* () {
            const startedAt = Date.now();
            input.onEvent?.({
              kind: "tool-dispatch-start",
              tick: tickIndex,
              callId: tc.id,
              name: tc.name,
              via: "model",
            });
            // Bridge to the reconciler hook store (ADR 55) — lights up
            // useOnToolStart. Fire-and-forget (a hook throw must not fail
            // the run).
            void input.reconciler.notifyLifecycle({
              mountId: input.mountId,
              event: {
                kind: "tool-start",
                tickId,
                callId: tc.id,
                name: tc.name,
                via: "model",
                executionId,
              },
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
              input.onEvent?.({
                kind: "tool-dispatch-end",
                tick: tickIndex,
                callId: tc.id,
                name: tc.name,
                outcome: dispatchSucceeded ? "succeeded" : "failed",
                durationMs,
              });
              void input.reconciler.notifyLifecycle({
                mountId: input.mountId,
                event: {
                  kind: "tool-end",
                  tickId,
                  callId: tc.id,
                  name: tc.name,
                  outcome: dispatchSucceeded ? "succeeded" : "failed",
                  durationMs,
                  executionId,
                },
              });
              input.onEvent?.({
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
            input.onEvent?.({
              kind: "tool-dispatch-end",
              tick: tickIndex,
              callId: tc.id,
              name: tc.name,
              outcome: "failed",
              durationMs,
            });
            void input.reconciler.notifyLifecycle({
              mountId: input.mountId,
              event: {
                kind: "tool-end",
                tickId,
                callId: tc.id,
                name: tc.name,
                outcome: "failed",
                durationMs,
                executionId,
              },
            });
            input.onEvent?.({
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
        acc.toolResults.push(...tickToolResults);

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

        acc.lastStopReason = result.stopReason;

        // 5. Continuation decision (ADR 67). The loop no longer owns a
        // scattered set of continuation authorities — it builds ONE
        // typed `TickResult`, lets the tree settle, then asks the session
        // for a single `TickEndForwardDecision` and folds it into its
        // (unchanged) two-tier resolution under the `maxTicks` hard cap.
        //
        // `provisionalContinue` is the loop's INTRINSIC default disposition
        // (tool_use with pending calls → keep ticking), computed BEFORE the
        // session's predicates run. It rides the `TickResult` as
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
        };

        // ADR 67 §"flip the tick-end order" — SETTLE FIRST. The reconciler
        // tick-end runs the tree's `useOnTickEnd` effects and settles the
        // IR so the session's continuation predicates read SETTLED state
        // (a tick-end effect may update a knob a gate checks). This
        // deliberately precedes the session decision below. AWAITED
        // in-fiber via the bridge.
        //
        // Lifecycle bridge (#206) — tick-end carries this tick's usage
        // (a past fact; becomes "prior usedTokens" for the next render's
        // utilization) + the settled `TickResult` (ADR 67 — the loop
        // executor's documented lifecycle payload).
        yield* awaitBridge(() =>
          input.reconciler.notifyLifecycle({
            mountId: input.mountId,
            event: {
              kind: "tick-end",
              tickId,
              executionId,
              result: tickResult,
              ...(result.usage !== undefined ? { metadata: { usage: result.usage } } : {}),
            },
          }),
        );

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
        const wantsContinue =
          forward?.kind === "stop" ? false : provisionalContinue || forward?.kind === "continue";
        const tickStopReason: string = !wantsContinue
          ? result.stopReason
          : acc.ticks >= input.maxTicks
            ? "max_ticks"
            : "continue";
        const tickDuration = Date.now() - tickStartedAt;
        const shouldContinue = wantsContinue && acc.ticks < input.maxTicks;
        input.onEvent?.({
          kind: "tick-end",
          tick: tickIndex,
          tickIndex,
          shouldContinue,
          stopReason: tickStopReason,
          usage: result.usage,
        });
        input.onEvent?.({
          kind: "tick",
          tick: tickIndex,
          tickIndex,
          stopReason: tickStopReason,
          usage: result.usage ?? zeroUsage(),
          durationMs: tickDuration,
        });

        if (!wantsContinue) {
          stopReason = result.stopReason;
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

      const runResult: ExecutionRunResult = {
        executionId,
        ticks: acc.ticks,
        usage: acc.usage,
        stopReason,
        output: acc.output,
        toolResults: acc.toolResults,
      };

      const wasAborted = this.aborted.has(executionId);
      const terminal: ExecutionTerminal = wasAborted
        ? {
            outcome: "canceled",
            reason: this.aborted.get(executionId),
            result: runResult,
          }
        : { outcome: "succeeded", result: runResult };

      // Emit execution-end + execution summary events. Bridge to the
      // reconciler hook store (ADR 55) so useOnExecutionEnd fires —
      // fire-and-forget (a hook throw must not fail the run).
      input.onEvent?.({
        kind: "execution-end",
        tick: acc.ticks,
        stopReason,
        ...(wasAborted ? { aborted: true } : {}),
      });
      void input.reconciler.notifyLifecycle({
        mountId: input.mountId,
        event: { kind: "execution-end", executionId, outcome: terminal.outcome },
      });
      // execution summary
      void executionStartedAt;

      return terminal;
    }).pipe(
      // Any uncaught twin failure (renderTree / project / normalize / run /
      // replaceReconcilerTools / apply* / a bridge reject) folds to
      // `ExecutionError` — the boundary the Promise original hit when an
      // un-try/caught `await` threw. The two locally-handled failures
      // (streaming `.result`, hard tool throw) are already absorbed in-body.
      Effect.catchAll(
        (cause): Effect.Effect<never, LoopExecutorError> =>
          Effect.fail(cause instanceof ExecutionError ? cause : new ExecutionError({ cause })),
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
}

// ============================================================================
// helpers
// ============================================================================

/**
 * Await a bridge NOTIFICATION (`reconciler.notifyLifecycle` /
 * `session.notifyTickEnd`) in-fiber. These carry no span and are bare
 * `async` (no `runHarnessProtocol` root), so `Effect.tryPromise` composes
 * them WITHOUT severing the fiber — the right tool for an external,
 * non-twin promise boundary. A rejection lands on the `E` channel, folding
 * to `ExecutionError` at the loop boundary (the Promise original's "an
 * un-caught awaited throw fails the run"). NOT `Effect.promise` — that
 * turns a reject into a defect that would bypass the boundary's catch.
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
function mergeAbortSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (external === undefined) return internal;
  if (external.aborted) return external;
  if (internal.aborted) return internal;
  const ctrl = new AbortController();
  const onExternal = (): void => ctrl.abort(external.reason);
  const onInternal = (): void => ctrl.abort(internal.reason);
  external.addEventListener("abort", onExternal, { once: true });
  internal.addEventListener("abort", onInternal, { once: true });
  return ctrl.signal;
}

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
