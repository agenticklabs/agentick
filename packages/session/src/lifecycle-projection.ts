/**
 * Lifecycle projection wiring (ADR 89 §4) — the SESSION is the
 * composition root, so IT registers the forwarders that project the
 * real command-hook lifecycle into the compiler's per-mount dispatch.
 * There is no bespoke lifecycle feed: the retired
 * `CompilerProtocol.notifyLifecycle` (the loop hand-feeding the
 * compiler) is gone, and every `useOn*` event below is a projection
 * of a declared command's ADR-80 hooks.
 *
 * ## The projection map (command hook → lifecycle event)
 *
 *  - `loop:run-execution` `onBefore`/`onAfter` → `execution-start` /
 *    `execution-end` (fire-and-forget, as the old feed was).
 *  - `loop:tick` `onBefore` → `tick-start` — AWAITED in-cascade before
 *    the render (a throw fails the run, the pinned pre-§4 behavior).
 *  - `loop:tick` `onAfter` → `tick-end` — THE SETTLE (ADR 67). The hook
 *    is an op-scoped `transform` middleware in the command cascade, so
 *    it is AWAITED **before the `loop:tick` terminal resolves** — i.e.
 *    before the loop's `yield* commandEffect` returns and before the
 *    DECIDE (`notifyTickEnd`) runs. A tick-end effect that mutates a
 *    knob is therefore visible to the session's continuation
 *    predicates, exactly as the old in-body settle guaranteed. Skipped
 *    for non-succeeded executor terminals (the old body settled only on
 *    success); a FAILED terminal projects an `error` event
 *    (`phase: "model"`) instead.
 *  - `tool:dispatch` around (`onToolDispatch`) → `tool-start` /
 *    `tool-end` (+ `error` with `phase: "tool"` on a HARD handler
 *    failure). The around form is used deliberately: `onAfter` hooks do
 *    not run on failed terminals, but the around interceptor's catch
 *    sees the failure in-path (ADR 83's one interceptor primitive — the
 *    in-process half of the ADR-89 observe/bus split). Loop-driven
 *    dispatches only (`context.tickId` present): host-door
 *    `session.tools.dispatch()` calls never produced lifecycle events, and
 *    `LifecycleToolStart.tickId` is required.
 *  - `model:generate[_stream]` `onBefore`/`onAfter` →
 *    `model-generate-start` / `model-generate-end` (fire-and-forget).
 *    BOTH tick paths mint a command (ADR 89 §1): the streaming tick rides
 *    `model:generate_stream`, the non-streaming `fx.run` composes through
 *    `model:generate` — so these fire on either path (the event's `stream`
 *    flag distinguishes them). These are NOT registered on the session's
 *    default executor
 *    instance: the loop may run a per-tick `<Model>`-swapped executor
 *    (ADR 56), which is adopter-constructed and outside the session's
 *    interceptor tree. The ONLY seam that reaches whichever executor
 *    instance issues this send's model calls is the ADR-76 tier-4
 *    call-scoped middleware, which the ADR-77 one-fiber spine threads
 *    through every nested `runOperation` — so the session wraps each
 *    `loop.fx.runExecution` in `withCallMiddleware(projection
 *    .callMiddleware, …)`.
 *
 * ## Routing + isolation
 *
 * The loop is an APP-SHARED singleton, so every tier-2 forwarder
 * filters by the identity the hook payload carries (`TickInput.mountId`
 * / `TickResult.sessionId` / `DispatchInput.context.sessionId`) before
 * dispatching to THIS session's mount. The tier-4 model forwarders need
 * no filter — they exist only inside this session's execution fiber.
 * Fire-and-forget dispatches swallow rejections (`NotMounted` during
 * teardown must not float); the awaited tick-start / tick-end
 * dispatches PROPAGATE (a missing mount fails the run — pinned).
 * Handler throws are isolated inside the compiler's dispatch either
 * way.
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §4
 */

import {
  hooksToMiddlewares,
  isOperationSignal,
  type CommandHooks,
  type Middleware,
  type RuntimeContext,
} from "@agentick/runtime";
import type {
  DispatchInput,
  DispatchResult,
  ExecutionTerminal,
  LifecycleEvent,
  LifecycleProjectionTarget,
  LoopExecutorProtocol,
  CompilerProtocol,
  RunExecutionInput,
  TickInput,
  TickResult,
  ToolExecutorProtocol,
  Unsubscribe,
} from "@agentick/spec";
import { supportsLifecycleProjection, TOOL_NARRATION_FIELD } from "@agentick/spec";

export interface LifecycleProjection {
  /**
   * The `model:generate[_stream]` forwarders, as call-scoped (tier-4)
   * middleware. The session wraps each `loop.fx.runExecution` effect in
   * `withCallMiddleware(projection.callMiddleware, …)` so the
   * projection reaches WHICHEVER executor instance runs a tick.
   */
  readonly callMiddleware: readonly Middleware<unknown, unknown, unknown>[];
  /** Unsubscribe every tier-2 forwarder (loop + tool executor). */
  dispose(): void;
}

export interface WireLifecycleProjectionOptions {
  readonly sessionId: string;
  readonly mountId: string;
  readonly compiler: CompilerProtocol;
  readonly loop: LoopExecutorProtocol;
  readonly toolExecutor: ToolExecutorProtocol;
}

/**
 * Register the session's lifecycle forwarders. Returns `undefined` when
 * the compiler does not expose the `LifecycleProjectionTarget`
 * capability (a compiler with no in-tree lifecycle surface) — the
 * projection is simply absent.
 */
export function wireLifecycleProjection(
  opts: WireLifecycleProjectionOptions,
): LifecycleProjection | undefined {
  const { sessionId, mountId, loop, toolExecutor, compiler } = opts;
  if (!supportsLifecycleProjection(compiler)) return undefined;
  const target: LifecycleProjectionTarget = compiler;

  /** Awaited dispatch — a rejection propagates into the command cascade. */
  const settle = (event: LifecycleEvent): Promise<void> =>
    target.dispatchLifecycle({ mountId, event });
  /** Fire-and-forget dispatch — a rejection (teardown NotMounted) never floats. */
  const notify = (event: LifecycleEvent): void => {
    void target.dispatchLifecycle({ mountId, event }).catch(() => {});
  };

  // ── loop forwarders (tier 2 on the app-shared loop; identity-filtered) ──
  const loopHooks = {
    onBeforeLoopRunExecution: (input: RunExecutionInput): void => {
      if (input.mountId !== mountId) return;
      notify({ kind: "execution-start", executionId: input.executionId });
    },
    onAfterLoopRunExecution: (terminal: ExecutionTerminal, ctx: RuntimeContext): void => {
      if (ctx.sessionId !== sessionId || ctx.executionId === undefined) return;
      notify({ kind: "execution-end", executionId: ctx.executionId, outcome: terminal.outcome });
    },
    onBeforeLoopTick: async (input: TickInput): Promise<void> => {
      if (input.mountId !== mountId) return;
      // AWAITED before the tick body renders — a throw vetoes the tick
      // and fails the run (→ ExecutionError), the pinned behavior of the
      // retired in-body tick-start bridge.
      await settle({
        kind: "tick-start",
        tickId: input.tickId,
        executionId: input.executionId,
      });
    },
    onAfterLoopTick: async (result: TickResult): Promise<void> => {
      if (result.sessionId !== sessionId) return;
      const terminal = result.executorTerminal;
      if (terminal.outcome === "succeeded") {
        // THE SETTLE (ADR 67 / ADR 89 §4) — awaited in the `loop:tick`
        // command cascade, BEFORE the command terminal resolves → before
        // the loop's DECIDE. Carries this tick's usage (becomes "prior
        // usedTokens" for the next render) + the settled `TickResult`.
        const usage = terminal.result.usage;
        await settle({
          kind: "tick-end",
          tickId: result.tickId,
          executionId: result.executionId,
          result,
          ...(usage !== undefined ? { metadata: { usage } } : {}),
        });
        return;
      }
      // No settle for non-succeeded terminals (the old in-body settle
      // only ran on success). A provider FAILURE projects `useOnError`.
      if (terminal.outcome === "failed") {
        notify({
          kind: "error",
          phase: "model",
          error: describeError(terminal.error),
          tickId: result.tickId,
          executionId: result.executionId,
        });
      }
    },
  };

  // ── tool forwarder (around `tool:dispatch` — sees failures in-path) ──
  const toolHooks = {
    onToolDispatch: async (
      input: DispatchInput,
      next: (input: DispatchInput) => Promise<DispatchResult>,
    ): Promise<DispatchResult> => {
      const c = input.context;
      const tickId = c.tickId;
      if (c.sessionId !== sessionId || tickId === undefined) return next(input);
      const startedAt = Date.now();
      notify({
        kind: "tool-start",
        tickId,
        callId: input.toolCallId,
        name: input.name,
        via: c.via,
        executionId: c.executionId,
        ...maybeNarration(input.input),
      });
      try {
        const out = await next(input);
        notify({
          kind: "tool-end",
          tickId,
          callId: input.toolCallId,
          name: input.name,
          // ADR 70 — a resolved dispatch is a success unless it flags a
          // soft/domain error; HARD failures reject (caught below).
          outcome: out.isError !== true ? "succeeded" : "failed",
          durationMs: out.durationMs ?? Date.now() - startedAt,
          executionId: c.executionId,
          ...(out.presentation !== undefined ? { presentation: out.presentation } : {}),
        });
        return out;
      } catch (err) {
        notify({
          kind: "tool-end",
          tickId,
          callId: input.toolCallId,
          name: input.name,
          outcome: "failed",
          durationMs: Date.now() - startedAt,
          executionId: c.executionId,
        });
        // A guard verdict (veto/replace/defer) is an outcome, not an
        // error — only real failures project `useOnError`.
        if (!isOperationSignal(err)) {
          notify({
            kind: "error",
            phase: "tool",
            error: describeError(err),
            tickId,
            executionId: c.executionId,
          });
        }
        throw err;
      }
    },
  };

  // ── model forwarders (tier 4 — ride the send's fiber to ANY executor) ──
  const modelHooks = {
    onBeforeModelGenerate: (_input: unknown, ctx: RuntimeContext): void => {
      notify(modelEvent("model-generate-start", false, ctx));
    },
    onAfterModelGenerate: (_out: unknown, ctx: RuntimeContext): void => {
      notify(modelEvent("model-generate-end", false, ctx));
    },
    onBeforeModelGenerateStream: (_input: unknown, ctx: RuntimeContext): void => {
      notify(modelEvent("model-generate-start", true, ctx));
    },
    onAfterModelGenerateStream: (_out: unknown, ctx: RuntimeContext): void => {
      notify(modelEvent("model-generate-end", true, ctx));
    },
  };

  // `hooksToMiddlewares` adapts each entry into an op-scoped `transform`
  // middleware (the ADR-83 amendment) — the same adapter the declarative
  // `createApp({ hooks })` fold uses. The configs are cast because the
  // session deliberately types its collaborators as protocols and does
  // not import the packages whose `CommandRegistry` augmentations mint
  // the typed keys; the handlers above are explicitly typed against the
  // spec shapes instead.
  const unsubs: Unsubscribe[] = [];
  for (const mw of hooksToMiddlewares(loopHooks as CommandHooks)) {
    unsubs.push(loop.fx.use(mw));
  }
  for (const mw of hooksToMiddlewares(toolHooks as unknown as CommandHooks)) {
    unsubs.push(toolExecutor.fx.use(mw));
  }
  const callMiddleware = hooksToMiddlewares(modelHooks as CommandHooks);

  return {
    callMiddleware,
    dispose(): void {
      for (const off of unsubs.splice(0)) off();
    },
  };
}

function modelEvent(
  kind: "model-generate-start" | "model-generate-end",
  stream: boolean,
  ctx: RuntimeContext,
): LifecycleEvent {
  return {
    kind,
    stream,
    ...(ctx.tickId !== undefined ? { tickId: ctx.tickId } : {}),
    ...(ctx.executionId !== undefined ? { executionId: ctx.executionId } : {}),
  };
}

/** Shape an unknown failure into the `LifecycleError.error` payload. */
function describeError(err: unknown): { name: string; message: string; data?: unknown } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (err !== null && typeof err === "object") {
    const tagged = err as { _tag?: unknown; message?: unknown };
    return {
      name: typeof tagged._tag === "string" ? tagged._tag : "Error",
      message: typeof tagged.message === "string" ? tagged.message : String(err),
      data: err,
    };
  }
  return { name: "Error", message: String(err) };
}

/**
 * Read the model's self-narration ({@link TOOL_NARRATION_FIELD}) off a
 * raw tool-call input for the eager tool-start spinner. READ-only — the
 * tool executor is the authority that STRIPS the field before
 * validation. Returns `{}` unless the field is a non-empty string.
 */
function maybeNarration(input: unknown): { narration?: string } {
  if (input === null || typeof input !== "object") return {};
  const value = (input as Record<string, unknown>)[TOOL_NARRATION_FIELD];
  return typeof value === "string" && value.length > 0 ? { narration: value } : {};
}
