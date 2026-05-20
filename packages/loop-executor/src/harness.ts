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
 *   5. continuation decision (default: stopReason === "tool_use" + pending
 *      tool calls → continue; else stop; bounded by maxTicks)
 *   6. loop
 *
 * Per-phase events on `surface: "loop"` give a single subscriber the
 * full execution flow without having to compose four other harnesses'
 * events.
 *
 * @see docs/proposals/v2/blueprint/05-loop-executor.md
 */

import { Effect } from "effect";

import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime";
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
  ToolCall,
  UsageStats,
} from "@agentick/spec";

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
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error("loop executor inbox dispatch not yet wired"),
    });
  }

  // ──────── internals ────────

  private runExecutionBody(
    input: RunExecutionInput,
  ): Effect.Effect<ExecutionTerminal, LoopExecutorError, never> {
    return Effect.tryPromise({
      try: () => this.runExecutionAsync(input),
      catch: (cause): LoopExecutorError => ({
        _tag: "ExecutionError",
        cause,
      }),
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

        // 1. Render.
        const renderResult = await input.reconciler.renderTree({
          mountId: input.mountId,
          sessionId: input.sessionId,
          executionId,
        });

        // 2. Execute.
        const executorTerminal: ExecutorTerminal<LanguageModelExecutionResult> =
          await input.executor.run({
            compiled: renderResult.tree,
            target: input.target,
            scope: { sessionId: input.sessionId, executionId, tickId },
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          });

        if (executorTerminal.outcome !== "succeeded") {
          // Mid-tick non-success terminal (failed / canceled / vetoed
          // / replaced). For 4d we treat these as loop terminators.
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

        // 3. Tool dispatch — every entry in result.toolCalls is a
        // request for Agentick to invoke. Provider-side tools come
        // back as tool_result blocks in result.output and don't
        // appear in toolCalls.
        const toolCalls: readonly ToolCall[] = result.toolCalls ?? [];
        const tickToolResults: LoopToolResult[] = [];
        for (const tc of toolCalls) {
          const startedAt = Date.now();
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
            tickToolResults.push({
              toolCallId: tc.id,
              toolName: tc.name,
              succeeded: dispatched.succeeded,
              content: dispatched.content,
              durationMs: dispatched.durationMs ?? Date.now() - startedAt,
            });
          } catch (err) {
            tickToolResults.push({
              toolCallId: tc.id,
              toolName: tc.name,
              succeeded: false,
              content: [],
              durationMs: Date.now() - startedAt,
              error: err,
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

        // 5. Continuation decision (default policy).
        const wantsContinue = result.stopReason === "tool_use" && tickToolResults.length > 0;
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
