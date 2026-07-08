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
 * Per-phase events on `surface: "loop"` give a single subscriber the
 * full execution flow without having to compose four other harnesses'
 * events.
 *
 * @see docs/proposals/v2/blueprint/05-loop-executor.md
 */

import { Effect } from "effect";

import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime-next";
import type {
  ContentBlock,
  ExecutionRunResult,
  ExecutionTerminal,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelStopReason,
  LoopExecutorError,
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
import { omitUndefined } from "@agentick/utils-next";

// ============================================================================
// Internal types
// ============================================================================

interface InFlightEntry {
  readonly executionId: string;
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

export class LoopExecutorHarness extends BaseHarness<"loop"> implements LoopExecutorProtocol {
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly aborted = new Map<string, string | undefined>();

  constructor(scopeId: string, journal: OperationJournal, bus: EventBus, inbox: MessageInbox) {
    super("loop", scopeId, journal, bus, inbox);
  }

  // ──────── LoopExecutorProtocol ────────

  runExecution(input: RunExecutionInput): Promise<ExecutionTerminal> {
    // ADR 51 classification: NOT a declarable command — the input
    // carries live object refs (reconciler, executor, toolExecutor,
    // stateApplicator callbacks, onEvent) and is in-process-only by
    // doctrine (§1.2). The addressable execution surface is the
    // session's (see session harness TODO(adr-51-session-verbs)).
    const op: Operation<RunExecutionInput, ExecutionTerminal> = {
      opId: `loop:execution:${input.executionId}`,
      surface: "loop",
      name: "loop:command:run-execution",
      scope: {
        sessionId: input.sessionId,
        executionId: input.executionId,
      },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.runExecutionBody(i)));
  }

  abort(input: { executionId: string; reason?: string }): Promise<void> {
    return runHarnessProtocol(
      Effect.sync(() => {
        this.aborted.set(input.executionId, input.reason ?? "aborted");
        const entry = this.inFlight.get(input.executionId);
        if (entry) entry.abortReason = input.reason ?? "aborted";
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

  private runExecutionBody(
    input: RunExecutionInput,
  ): Effect.Effect<ExecutionTerminal, LoopExecutorError, never> {
    return Effect.tryPromise({
      try: () => this.runExecutionAsync(input),
      catch: (cause): LoopExecutorError => new ExecutionError({ cause }),
    });
  }

  /**
   * Promise-shaped body for the tick loop. Composes the four downstream
   * harnesses (reconciler, executor, tool-executor, state applicator)
   * via their public Promise surfaces. The loop's own typed lifecycle
   * goes through `runOperation` at the public entry point.
   */
  private async runExecutionAsync(input: RunExecutionInput): Promise<ExecutionTerminal> {
    const executionId = input.executionId;
    this.inFlight.set(executionId, { executionId });

    try {
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
        | "executor_failed" = "end";

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
        // entire useOn* family is inert (no producer).
        await input.reconciler.notifyLifecycle({
          mountId: input.mountId,
          event: { kind: "tick-start", tickId, executionId },
        });

        // 1. Render. The RenderContext envelope rides render-context
        // (ADR 54 / 55) so useContextInfo / useRenderContext read it
        // SYNCHRONOUSLY during this render — adaptive-compaction components
        // react before the IR freezes.
        const renderResult = await input.reconciler.renderTree({
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
        const reconcilerTools = renderResult.tree.declarations?.tools ?? [];
        const reconcilerBinding = { scope: "reconciler", mountId: input.mountId } as const;
        await input.toolExecutor.replaceReconcilerTools({
          mountId: input.mountId,
          registrations: reconcilerTools.map((d) => toRegistration(d, reconcilerBinding)),
        });
        const modelTools = await input.toolExecutor.compileForTick({ exposure: "model" });

        // 3. Execute. Streaming path (executeStream) when the caller
        //    requested streaming AND the executor supports it AND the
        //    target's capabilities don't explicitly disable it.
        const wantsStreaming =
          (input.stream ?? false) &&
          typeof tickExecutor.executeStream === "function" &&
          (tickTarget.capabilities?.supportsStreaming ?? true);

        let executorTerminal: ExecutorTerminal<LanguageModelExecutionResult>;

        if (wantsStreaming && tickExecutor.executeStream) {
          // Streaming path. The adapter emits AdapterDeltas (including
          // the symmetric summary events: message, content, tool-call,
          // reasoning, message-end). We forward each delta through
          // onEvent — NO loop-side synthesis on this path (adapter
          // already owns symmetric event emission).
          const projected = await tickExecutor.project({
            compiled: tickCompiled,
            target: tickTarget,
            scope: { sessionId: input.sessionId, executionId, tickId },
            tools: modelTools,
          });
          const stream = tickExecutor.executeStream({
            targetInput: projected,
            target: tickTarget,
            scope: { sessionId: input.sessionId, executionId, tickId },
            ...omitUndefined({ signal: input.signal }),
          });
          try {
            for await (const delta of stream) {
              input.onEvent?.({ kind: "model", tick: tickIndex, delta });
            }
          } catch {
            // #182 Option A: the iterator throws the typed error on
            // provider failure. The SAME error arrives on `.result`
            // below — that path owns terminal construction; swallowing
            // here avoids double-handling.
          }
          let raw: unknown;
          try {
            raw = await stream.result;
          } catch (cause) {
            // executor.execute rejection — treat as failed terminal.
            executorTerminal = {
              outcome: "failed",
              error: new ProviderRejected({ cause }),
            };
            stopReason = "executor_failed";
            break;
          }
          const normalized = await tickExecutor.normalize({
            targetOutput: raw,
            target: tickTarget,
            scope: { sessionId: input.sessionId, executionId, tickId },
          });
          executorTerminal = { outcome: "succeeded", result: normalized };
        } else {
          // Non-streaming path: classic project → execute → normalize via run.
          executorTerminal = await tickExecutor.run({
            compiled: tickCompiled,
            target: tickTarget,
            scope: { sessionId: input.sessionId, executionId, tickId },
            tools: modelTools,
            ...omitUndefined({ signal: input.signal }),
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

        // 3. Tool dispatch — every entry in result.toolCalls is a
        // request for Agentick to invoke. Provider-side tools come
        // back as tool_result blocks in result.output and don't
        // appear in toolCalls.
        const toolCalls: readonly ToolCall[] = result.toolCalls ?? [];
        const tickToolResults: LoopToolResult[] = [];
        for (const tc of toolCalls) {
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
          try {
            const dispatched = await input.toolExecutor.dispatch({
              toolCallId: tc.id,
              name: tc.name,
              input: tc.input,
              context: {
                via: "model",
                sessionId: input.sessionId,
                executionId,
                tickId,
              },
            });
            const durationMs = dispatched.durationMs ?? Date.now() - startedAt;
            tickToolResults.push({
              toolCallId: tc.id,
              toolName: tc.name,
              succeeded: dispatched.succeeded,
              content: dispatched.content,
              durationMs,
            });
            input.onEvent?.({
              kind: "tool-dispatch-end",
              tick: tickIndex,
              callId: tc.id,
              name: tc.name,
              outcome: dispatched.succeeded ? "succeeded" : "failed",
              durationMs,
            });
            void input.reconciler.notifyLifecycle({
              mountId: input.mountId,
              event: {
                kind: "tool-end",
                tickId,
                callId: tc.id,
                name: tc.name,
                outcome: dispatched.succeeded ? "succeeded" : "failed",
                durationMs,
                executionId,
              },
            });
            input.onEvent?.({
              kind: "tool-dispatch",
              tick: tickIndex,
              callId: tc.id,
              name: tc.name,
              content: dispatched.content,
              succeeded: dispatched.succeeded,
              durationMs,
            });
          } catch (err) {
            const durationMs = Date.now() - startedAt;
            tickToolResults.push({
              toolCallId: tc.id,
              toolName: tc.name,
              succeeded: false,
              content: [],
              durationMs,
              error: err,
            });
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
          }
        }
        acc.toolResults.push(...tickToolResults);

        // 4. State application — the session harness's apply commands.
        // NoopStateApplicator records nothing; real session harness
        // will write timeline entries here so the next render sees them.
        await input.stateApplicator.applyExecutorResult({
          sessionId: input.sessionId,
          executionId,
          tickId,
          result,
        });
        if (tickToolResults.length > 0) {
          await input.stateApplicator.applyToolResults({
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
        // deliberately precedes the session decision below.
        //
        // Lifecycle bridge (#206) — tick-end carries this tick's usage
        // (a past fact; becomes "prior usedTokens" for the next render's
        // utilization) + the settled `TickResult` (ADR 67 — the loop
        // executor's documented lifecycle payload).
        await input.reconciler.notifyLifecycle({
          mountId: input.mountId,
          event: {
            kind: "tick-end",
            tickId,
            executionId,
            result: tickResult,
            ...(result.usage !== undefined ? { metadata: { usage: result.usage } } : {}),
          },
        });

        // ADR 67 §"flip the tick-end order" — THEN DECIDE. The session
        // folds its continuation predicates (gates + steering + tree stop)
        // into ONE `TickEndForwardDecision`, reading the settled
        // `TickResult`. The loop's combination below is UNCHANGED — it
        // already implements the two-tier resolution (stop-force >
        // continue-force > abstain), with `maxTicks` as the tier-1 hard cap.
        const forward = await input.notifyTickEnd?.({
          sessionId: input.sessionId,
          executionId,
          tickId,
          outcome: "succeeded",
          result: tickResult,
        });
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
    } finally {
      this.inFlight.delete(executionId);
      this.aborted.delete(executionId);
    }
  }
}

// ============================================================================
// helpers
// ============================================================================

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
