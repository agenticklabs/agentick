/**
 * `ToolExecutorHarness` — reference implementation of
 * `ToolExecutorProtocol`.
 *
 * Extends `BaseHarness<"tool">` from `@agentick/runtime`. Owns:
 *
 *   - an in-memory tool registry (declaration + handlerRef + useDeps),
 *   - a handler resolver (handlerRef → handler + validator),
 *   - a per-call AbortController map for in-flight tracking.
 *
 * Validation, exposure checks, handler invocation, and abort all run
 * inside `runOperation`, so every dispatch produces the canonical
 * phase-contract envelope sequence
 * (`requested → before → terminal`) on `surface: "tool"`.
 *
 * Phase 4a.4 covers the happy path + abort. Confirmation flow (4a.5),
 * middleware + lifecycle handler hooks (4a.6), and inbox dispatcher
 * (4a.7) land in follow-up commits.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { runHarnessProtocol, ulid } from "@agentick/runtime";
import { BaseHarness } from "@agentick/runtime";
import type {
  AbortInput,
  ChannelPublisher,
  ContentBlock,
  DispatchInput,
  DispatchResult,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  RegisterToolInput,
  ToolDeclaration,
  ToolExecutorProtocol,
  ToolListFilter,
  ToolRegistration,
  UnregisterToolInput,
} from "@agentick/spec";

import { InMemoryToolRegistry } from "./registry.js";
import type {
  HandlerEntry,
  HandlerResolver,
  HandlerChannelSeed,
  ToolExecutorHarnessOptions,
  ToolHandlerCtx,
  ValidatorResult,
} from "./types.js";

interface InFlightEntry {
  readonly controller: AbortController;
  readonly toolName: string;
}

export class ToolExecutorHarness
  extends BaseHarness<"tool">
  implements ToolExecutorProtocol
{
  private readonly registry = new InMemoryToolRegistry();
  private readonly handlerResolver: HandlerResolver;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly stateStore = new Map<string, unknown>();
  private readonly defaultTimeoutMs?: number;
  private readonly channelPublisher?: ChannelPublisher;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: ToolExecutorHarnessOptions,
  ) {
    super("tool", scopeId, journal, bus, inbox);
    this.handlerResolver = options.handlerResolver;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.channelPublisher = options.channelPublisher;

    // Eager registrations applied synchronously so callers can dispatch
    // immediately after `await harness.ready`.
    if (options.initialTools) {
      for (const reg of options.initialTools) this.registry.add(reg);
    }
  }

  // ──────────────────────── ToolExecutorProtocol ────────────────────────

  register(input: RegisterToolInput): Promise<void> {
    const name = input.registration.declaration.name;
    const op: Operation<RegisterToolInput, void> = {
      opId: input.opId ?? `tool:register:${name}:${ulid()}`,
      surface: "tool",
      name: "tool:command:register",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.registry.add(i.registration);
        }),
      ),
    );
  }

  unregister(input: UnregisterToolInput): Promise<void> {
    const op: Operation<UnregisterToolInput, void> = {
      opId: input.opId ?? `tool:unregister:${input.name}:${ulid()}`,
      surface: "tool",
      name: "tool:command:unregister",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.registry.remove(i.name);
        }),
      ),
    );
  }

  async list(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]> {
    // Pure read — bypass runOperation so list() doesn't pollute the
    // journal with no-op envelopes. Conformance only requires correct
    // shape; the bus / journal don't care about reads.
    return this.registry.list(filter);
  }

  dispatch(input: DispatchInput): Promise<DispatchResult> {
    const op: Operation<DispatchInput, DispatchResult> = {
      opId: input.opId ?? `tool:dispatch:${input.toolCallId}`,
      surface: "tool",
      name: "tool:command:dispatch",
      scope: {
        sessionId: input.context.sessionId,
        executionId: input.context.executionId,
        tickId: input.context.tickId,
      },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) => this.dispatchBody(i)),
    );
  }

  async abort(input: AbortInput): Promise<void> {
    const entry = this.inFlight.get(input.toolCallId);
    if (!entry) return; // no-op for unknown ids
    entry.controller.abort({
      _tag: "ToolAbortedError",
      toolCallId: input.toolCallId,
      reason: input.reason,
    });
    // The dispatchBody promise will see the abort + reject with
    // ToolAbortedError; we leave cleanup of inFlight to the dispatch
    // path's `finally`.
  }

  // ──────────────────────── State store (handler ctx) ────────────────────────

  /**
   * Read state previously set by a tool handler via
   * `ctx.setState(key, value)`. Used by the stateful tool render
   * pattern (`<Tool render={() => …}>`).
   */
  getState(key: string): unknown {
    return this.stateStore.get(key);
  }

  /** Snapshot the entire handler state map. */
  snapshotState(): Readonly<Record<string, unknown>> {
    return Object.fromEntries(this.stateStore.entries());
  }

  // ──────────────────────── inbox dispatch ────────────────────────

  /**
   * Inbox dispatcher. The full message handling (abort + confirmation
   * response) lands in Phase 4a.7. For now we reject unknown messages
   * via the BaseHarness default `HandlerError` envelope.
   */
  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error("tool executor inbox dispatch not yet wired (Phase 4a.7)"),
    });
  }

  // ──────────────────────── internals ────────────────────────

  /**
   * Effect-shaped body. Runs inside `runOperation`'s FiberRef scope so
   * Effect-typed handlers see the active `RuntimeContext` via
   * `getContext`. Promise / sync handlers bridge out via `Effect.tryPromise`
   * / `Effect.sync` and receive scope through the explicit `ctx` arg
   * the harness builds from the operation input.
   */
  private dispatchBody(
    input: DispatchInput,
  ): Effect.Effect<DispatchResult, unknown, never> {
    return Effect.gen(this, function* () {
      const reg = this.registry.get(input.name);
      if (!reg) {
        return yield* Effect.fail({
          _tag: "ToolNotFoundError",
          name: input.name,
          registered: this.registry.names(),
        } as const);
      }
      if (!reg.declaration.exposure.includes(input.context.via)) {
        return yield* Effect.fail({
          _tag: "ToolPermissionError",
          toolName: input.name,
          via: input.context.via,
          reason: `tool "${input.name}" is not exposed via "${input.context.via}"`,
        } as const);
      }

      const entry = this.handlerResolver.resolve(reg.handlerRef);
      if (!entry) {
        return yield* Effect.fail({
          _tag: "ToolHandlerMissing",
          toolName: input.name,
          handlerRef: reg.handlerRef,
        } as const);
      }

      // Validate input. Validator may be sync or async — both shapes
      // sit inside Effect.tryPromise (sync resolves immediately).
      const result = yield* Effect.tryPromise({
        try: async () => entry.validator.validate(input.input),
        catch: (cause): { readonly _tag: "ToolValidationError"; readonly cause: unknown } => ({
          _tag: "ToolValidationError",
          cause,
        }),
      });
      if (isValidationFailure(result)) {
        return yield* Effect.fail({
          _tag: "ToolValidationError",
          toolName: input.name,
          issues: result.issues,
        } as const);
      }
      const validated = result.value;

      // Per-dispatch abort plumbing. Effect-typed handlers also see
      // fiber interrupts; Promise/sync handlers see the AbortSignal.
      const controller = new AbortController();
      this.inFlight.set(input.toolCallId, { controller, toolName: input.name });

      const callerSignal = input.signal;
      const onCallerAbort = () => controller.abort(callerSignal?.reason);
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

      const timeoutMs =
        input.timeoutMs ?? reg.declaration.annotations?.timeout ?? this.defaultTimeoutMs;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          controller.abort({
            _tag: "ToolTimeoutError",
            toolName: input.name,
            ms: timeoutMs,
          });
        }, timeoutMs);
      }

      const channelEmits: HandlerChannelSeed[] = [];
      const publisher = this.channelPublisher;
      const opIdForCausality = input.opId ?? `tool:dispatch:${input.toolCallId}`;
      const ctx: ToolHandlerCtx = {
        toolCallId: input.toolCallId,
        ...(input.context.sessionId !== undefined ? { sessionId: input.context.sessionId } : {}),
        ...(input.context.executionId !== undefined
          ? { executionId: input.context.executionId }
          : {}),
        ...(input.context.tickId !== undefined ? { tickId: input.context.tickId } : {}),
        signal: controller.signal,
        setState: (key: string, value: unknown): void => {
          this.stateStore.set(key, value);
        },
        emit: (seed: HandlerChannelSeed): void => {
          // Always retain seeds for observability tests / inspection;
          // route to the publisher when one is wired.
          channelEmits.push(seed);
          if (publisher) {
            const channel = seed.name.replace(/^session:channel:/, "");
            Effect.runFork(
              publisher.publish({
                channel,
                payload: seed.payload,
                ...(seed.metadata !== undefined ? { metadata: seed.metadata } : {}),
                parentOpId: opIdForCausality,
                scope: {
                  ...(input.context.sessionId !== undefined
                    ? { sessionId: input.context.sessionId }
                    : {}),
                  ...(input.context.executionId !== undefined
                    ? { executionId: input.context.executionId }
                    : {}),
                  ...(input.context.tickId !== undefined ? { tickId: input.context.tickId } : {}),
                },
              }),
            );
          }
        },
      };

      const useDeps: Readonly<Record<string, unknown>> = {
        ...(reg.useDeps ?? {}),
        ...(input.context.use ?? {}),
      };

      const started = Date.now();

      // Compose body that branches on handler shape.
      const invokeHandler = Effect.suspend((): Effect.Effect<readonly ContentBlock[], unknown, never> => {
        if (controller.signal.aborted) {
          return Effect.fail(
            controller.signal.reason ?? {
              _tag: "ToolAbortedError",
              toolCallId: input.toolCallId,
            },
          );
        }
        const handlerResult = entry.handler(validated, { ctx, use: useDeps });

        if (isEffect(handlerResult)) {
          // Effect-typed handler — yields IN the parent fiber so it
          // inherits the `RuntimeContextRef` FiberRef set by
          // `runOperation`. Abort signals translate to fiber interrupts
          // via `Effect.race` with an AbortSignal-driven failure.
          const abortEff: Effect.Effect<never, unknown, never> = Effect.async<never, unknown, never>(
            (resume) => {
              if (controller.signal.aborted) {
                resume(
                  Effect.fail(
                    controller.signal.reason ?? {
                      _tag: "ToolAbortedError",
                      toolCallId: input.toolCallId,
                    },
                  ),
                );
                return;
              }
              const onAbort = () => {
                resume(
                  Effect.fail(
                    controller.signal.reason ?? {
                      _tag: "ToolAbortedError",
                      toolCallId: input.toolCallId,
                    },
                  ),
                );
              };
              controller.signal.addEventListener("abort", onAbort, { once: true });
              return Effect.sync(() =>
                controller.signal.removeEventListener("abort", onAbort),
              );
            },
          );
          return Effect.race(handlerResult, abortEff);
        }

        if (isPromiseLike(handlerResult)) {
          return Effect.tryPromise({
            try: () =>
              Promise.race([
                handlerResult as PromiseLike<readonly ContentBlock[]>,
                abortPromise(controller.signal),
              ]) as Promise<readonly ContentBlock[]>,
            catch: (cause: unknown) => cause,
          });
        }

        return Effect.succeed(handlerResult);
      });

      const exit = yield* Effect.exit(invokeHandler);

      // Cleanup runs unconditionally.
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.inFlight.delete(input.toolCallId);
      void channelEmits;

      if (Exit.isSuccess(exit)) {
        const dispatchResult: DispatchResult = {
          toolCallId: input.toolCallId,
          name: input.name,
          succeeded: true,
          content: exit.value,
          executedBy: "agentick",
          durationMs: Date.now() - started,
        };
        return dispatchResult;
      }

      // Failure: distinguish abort vs handler error.
      const failure = Cause.failureOption(exit.cause);
      const rawErr = Option.isSome(failure) ? failure.value : undefined;
      const abortReason = controller.signal.aborted
        ? controller.signal.reason ?? rawErr
        : undefined;
      if (abortReason !== undefined) {
        return yield* Effect.fail(
          isTaggedAbort(abortReason)
            ? abortReason
            : ({
                _tag: "ToolAbortedError",
                toolCallId: input.toolCallId,
                reason: typeof abortReason === "string" ? abortReason : undefined,
              } as const),
        );
      }
      if (rawErr !== undefined && isTaggedToolError(rawErr)) {
        return yield* Effect.fail(rawErr);
      }
      return yield* Effect.fail({
        _tag: "ToolHandlerError",
        toolName: input.name,
        cause: rawErr ?? exit.cause,
      } as const);
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isValidationFailure(
  r: ValidatorResult,
): r is { value?: undefined; issues: ValidatorResult extends { issues: infer I } ? I : never } {
  return Array.isArray((r as { issues?: unknown }).issues);
}

/**
 * Resolves never; rejects with the signal's reason when the signal
 * aborts. Used in `Promise.race` to short-circuit a handler invocation
 * the moment an abort fires.
 */
function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("aborted")),
      { once: true },
    );
  });
}

function isTaggedAbort(value: unknown): value is { readonly _tag: string } {
  if (value === null || typeof value !== "object") return false;
  const tag = (value as { _tag?: unknown })._tag;
  return tag === "ToolAbortedError" || tag === "ToolTimeoutError";
}

function isEffect(
  value: unknown,
): value is Effect.Effect<readonly ContentBlock[], unknown, never> {
  return typeof value === "object" && value !== null && Effect.EffectTypeId in value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isTaggedToolError(
  value: unknown,
): value is { readonly _tag: string } {
  if (value === null || typeof value !== "object") return false;
  const tag = (value as { _tag?: unknown })._tag;
  return (
    tag === "ToolNotFoundError" ||
    tag === "ToolPermissionError" ||
    tag === "ToolHandlerMissing" ||
    tag === "ToolValidationError" ||
    tag === "ToolAbortedError" ||
    tag === "ToolTimeoutError" ||
    tag === "ToolHandlerError"
  );
}

// Silence unused-import linting until 4a.6+ uses ToolRegistration alias.
void (undefined as unknown as ToolRegistration);
