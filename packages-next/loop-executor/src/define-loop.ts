/**
 * `defineLoop` — callback-style `LoopExecutorProtocol` factory.
 *
 * Lets a user satisfy `LoopExecutorProtocol` without subclassing
 * `BaseHarness`. Bring a `runExecution` callback (and optionally an
 * `abort` override), receive a `LoopExecutorFactory` ready to drop into
 * `createApp({ loop: ... })`.
 *
 * The MVP is intentionally raw: the callback receives the full
 * `RunExecutionInput` (reconciler / model-executor / tool-executor /
 * stateApplicator references) and returns an `ExecutionTerminal`.
 * Adopters who want a custom loop architecture (parallel multi-model,
 * single-call no-tool-loop, test harness, …) write the whole thing.
 * Adopters who want to customize a single tick step should subclass
 * `LoopExecutorHarness` instead.
 *
 * ```ts
 * const myLoop = defineLoop({
 *   async runExecution(input) {
 *     // single tick, no tool loop
 *     const projected = await input.modelExecutor.project({
 *       compiled: (await input.reconciler.renderTree({ mountId: input.mountId })).tree,
 *       target: input.target,
 *     });
 *     const terminal = await input.modelExecutor.run({
 *       compiled: ...,
 *       target: input.target,
 *       scope: { executionId: input.executionId, sessionId: input.sessionId },
 *     });
 *     return { outcome: "succeeded", result: terminal.result! };
 *   },
 * });
 *
 * const app = await createApp(<Agent />, {
 *   model: openai("gpt-4o"),
 *   loop: myLoop,
 * });
 * ```
 *
 * Under the hood the factory constructs a `CallbackLoopExecutor` — a
 * thin `BaseHarness<"loop">` subclass that delegates `runExecution` /
 * `abort` to the supplied callbacks. The substrate phase contract
 * applies uniformly.
 *
 * @see docs/proposals/v2/IMPLEMENTATION-PLAN.md (FAÇADE.6)
 */

import { Effect } from "effect";
import {
  BaseHarness,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  runHarnessProtocol,
  ulid,
} from "@agentick/runtime-next";
import type {
  EventBus,
  ExecutionTerminal,
  LoopExecutorError,
  LoopExecutorFactory,
  LoopExecutorFactoryDeps,
  LoopExecutorFx,
  LoopExecutorProtocol,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  RunExecutionInput,
  SubstrateError,
} from "@agentick/spec-next";
import { ExecutionError, HandlerError } from "@agentick/spec-next";

// ============================================================================
// Public API
// ============================================================================

export interface DefineLoopInput {
  /**
   * Run one full agent execution from start to terminal. The callback
   * receives the orchestration handles (reconciler / model-executor /
   * tool-executor / stateApplicator) and the bounds (`maxTicks`,
   * `signal`). Returns the assembled `ExecutionTerminal`.
   *
   * Throw to fail the execution — the harness translates exceptions
   * into the terminal envelope with `outcome: "failed"`.
   */
  readonly runExecution: (input: RunExecutionInput) => Promise<ExecutionTerminal>;

  /**
   * Optional custom abort. When omitted, the harness tracks in-flight
   * executions via AbortController and aborts them on this call.
   * Adopters whose `runExecution` doesn't honor the input's `signal`
   * MUST supply this to route aborts manually.
   */
  readonly abort?: (input: {
    readonly executionId: string;
    readonly reason?: string;
  }) => Promise<void>;
}

/**
 * Construct a `LoopExecutorFactory` from a callback bundle. Plug the
 * factory into `createApp({ loop: ... })` to share substrate, or
 * invoke standalone for testing.
 */
export function defineLoop(spec: DefineLoopInput): LoopExecutorFactory {
  const factory = (deps?: LoopExecutorFactoryDeps): LoopExecutorProtocol => {
    const scopeId = deps?.scopeId ?? `define-loop:${ulid()}`;
    const journal = deps?.journal ?? new MemoryJournal();
    const bus = deps?.bus ?? new LocalEventBus();
    const inbox = deps?.inbox ?? new LocalInbox();
    return new CallbackLoopExecutor(scopeId, journal, bus, inbox, spec);
  };
  return Object.assign(factory, { loopExecutorFactory: true as const });
}

// ============================================================================
// CallbackLoopExecutor
// ============================================================================

interface InFlightEntry {
  readonly executionId: string;
  readonly controller: AbortController;
}

class CallbackLoopExecutor extends BaseHarness<"loop"> implements LoopExecutorProtocol {
  private readonly spec: DefineLoopInput;
  private readonly inFlight = new Map<string, InFlightEntry>();

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    spec: DefineLoopInput,
  ) {
    super("loop", scopeId, journal, bus, inbox);
    this.spec = spec;
  }

  get fx(): LoopExecutorFx {
    return {
      use: (mw) => this.registerEffectMiddleware(mw),
      runExecution: (input) => this.runExecutionFx(input),
    };
  }

  private runExecutionFx(
    input: RunExecutionInput,
  ): Effect.Effect<ExecutionTerminal, LoopExecutorError | SubstrateError, never> {
    const op: Operation<RunExecutionInput, ExecutionTerminal, LoopExecutorError> = {
      opId: `loop:run-execution:${input.executionId}`,
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

  async abort(input: { readonly executionId: string; readonly reason?: string }): Promise<void> {
    if (this.spec.abort) {
      await this.spec.abort(input);
      return;
    }
    const entry = this.inFlight.get(input.executionId);
    if (!entry) return;
    entry.controller.abort(input.reason ?? "aborted");
  }

  // ──────── inbox dispatch (deferred) ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({
        cause: new Error("defineLoop inbox dispatch not yet wired (FAÇADE.6 MVP)"),
      }),
    );
  }

  // ──────── internals ────────

  private runExecutionBody(
    input: RunExecutionInput,
  ): Effect.Effect<ExecutionTerminal, LoopExecutorError, never> {
    return Effect.tryPromise({
      try: async () => {
        // Always honor the caller-supplied signal; layer our own
        // controller on top for `abort()` calls. The combined signal is
        // passed through to the user callback.
        const controller = new AbortController();
        if (input.signal) {
          if (input.signal.aborted) {
            controller.abort(input.signal.reason);
          } else {
            input.signal.addEventListener("abort", () => controller.abort(input.signal!.reason), {
              once: true,
            });
          }
        }
        this.inFlight.set(input.executionId, {
          executionId: input.executionId,
          controller,
        });
        try {
          const merged: RunExecutionInput = { ...input, signal: controller.signal };
          return await this.spec.runExecution(merged);
        } finally {
          this.inFlight.delete(input.executionId);
        }
      },
      catch: (cause): LoopExecutorError => {
        if (
          cause &&
          typeof cause === "object" &&
          "_tag" in cause &&
          typeof (cause as { _tag?: unknown })._tag === "string"
        ) {
          return cause as LoopExecutorError;
        }
        return new ExecutionError({ cause });
      },
    });
  }
}
