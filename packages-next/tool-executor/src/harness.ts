/**
 * `ToolExecutorHarness` — reference implementation of
 * `ToolExecutorProtocol`.
 *
 * Extends `BaseHarness<"tool">` from `@agentick/runtime-next`. Owns:
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

import { Cause, Effect, Exit, Option } from "effect";
import { runHarnessProtocol, ulid } from "@agentick/runtime-next";
import { BaseHarness, type LifecycleHandler, type Unsubscribe } from "@agentick/runtime-next";
import type {
  AbortInput,
  ChannelPublisher,
  ContentBlock,
  DispatchInput,
  DispatchResult,
  ElicitationHarnessProtocol,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  RegisterToolInput,
  ToolDeclaration,
  ToolExecutorInboxMessage,
  ToolExecutorProtocol,
  ToolListFilter,
  ToolRegistration,
  UnregisterToolInput,
} from "@agentick/spec-next";

import {
  TOOL_CONFIRMATION_KIND,
  TOOL_CONFIRMATION_REPLY_SCHEMA,
  type ToolConfirmationReply,
} from "./confirmation-schema.js";
import { InMemoryToolRegistry } from "./registry.js";
import type {
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

export class ToolExecutorHarness extends BaseHarness<"tool"> implements ToolExecutorProtocol {
  private readonly registry = new InMemoryToolRegistry();
  private readonly handlerResolver: HandlerResolver;
  private readonly inFlight = new Map<string, InFlightEntry>();
  /** Tool names the host has marked `always` for this session. */
  private readonly alwaysAllowed = new Set<string>();
  private readonly stateStore = new Map<string, unknown>();
  private readonly defaultTimeoutMs?: number;
  private readonly defaultConfirmationTimeoutMs?: number;
  private readonly channelPublisher?: ChannelPublisher;
  private readonly elicitation: ElicitationHarnessProtocol;

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
    this.defaultConfirmationTimeoutMs = options.defaultConfirmationTimeoutMs;
    this.channelPublisher = options.channelPublisher;
    this.elicitation = options.elicitation;

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
    return runHarnessProtocol(this.runOperation(op, (i) => this.dispatchBody(i)));
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

  // ──────────────────────── lifecycle hooks (4a.6) ────────────────────────
  //
  // `use(middleware)` is inherited from BaseHarness — it's the universal
  // primitive. Subclasses don't re-expose it (would duplicate). Typed
  // call sites pass generics:
  //
  //   tools.use<DispatchInput, DispatchResult>((input, next) => ...);

  /**
   * Register a handler that runs BEFORE every dispatch's body. The
   * handler can return a `HandlerVerdict` to influence execution:
   *
   *   - `{ kind: "proceed" }` (or void) — continue normally
   *   - `{ kind: "veto", reason? }` — abort dispatch, terminal:vetoed
   *   - `{ kind: "replace", result, reason? }` — short-circuit with
   *     the supplied result, terminal:replaced
   *   - `{ kind: "defer", retryAfter? }` — terminal:deferred (caller
   *     responsibility to retry)
   *
   * Returns `Unsubscribe`. Multiple handlers compose per the
   * `mergeVerdict` rules: veto > replace > defer > proceed.
   *
   * Re-exposes `BaseHarness.handlers.register("before", ...)` with a
   * tool-typed signature.
   */
  onBeforeDispatch(handler: LifecycleHandler<DispatchInput, DispatchResult, unknown>): Unsubscribe {
    return this.handlers.register("before", handler as LifecycleHandler<unknown, unknown, unknown>);
  }

  // ──────────────────────── inbox dispatch ────────────────────────

  /**
   * Inbox dispatcher. The tool executor handles `abort` only. The
   * legacy `confirmation-response` message type retired with the
   * ElicitationHarness refactor — confirmation responses now arrive
   * on the elicitation harness's address, not here.
   *
   * Unknown message types route to `HandlerError`.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    const payload = msg.payload as ToolExecutorInboxMessage | undefined;
    if (!payload || typeof payload !== "object" || !("type" in payload)) {
      return Effect.fail({
        _tag: "HandlerError",
        cause: new Error("tool inbox: payload missing or untagged"),
      });
    }
    switch (payload.type) {
      case "abort":
        return Effect.sync(() => {
          this.abortInFlight(payload.toolCallId, payload.reason);
        });
      default: {
        const unknownType = (payload as { type: string }).type;
        return Effect.fail({
          _tag: "HandlerError",
          cause: new Error(`tool inbox: unknown message type "${unknownType}"`),
        });
      }
    }
  }

  /**
   * In-process abort path used by both the protocol-level `abort()`
   * method and the inbox `abort` message. Triggers the AbortController
   * for an active dispatch — the dispatch's abort signal is also
   * threaded into the in-flight `this.request(...)` (when a
   * confirmation is pending), so the registry's signal-abort handler
   * rejects the pending Deferred. The dispatchBody's
   * `Effect.catchTag("RequestAbortedError", ...)` converts that
   * rejection into a denial-shaped `DispatchResult`.
   */
  private abortInFlight(toolCallId: string, reason?: string): void {
    const entry = this.inFlight.get(toolCallId);
    if (entry) {
      entry.controller.abort({
        _tag: "ToolAbortedError",
        toolCallId,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
  }

  // ──────────────────────── internals ────────────────────────

  /**
   * Effect-shaped body. Runs inside `runOperation`'s FiberRef scope so
   * Effect-typed handlers see the active `RuntimeContext` via
   * `getContext`. Promise / sync handlers bridge out via `Effect.tryPromise`
   * / `Effect.sync` and receive scope through the explicit `ctx` arg
   * the harness builds from the operation input.
   */
  private dispatchBody(input: DispatchInput): Effect.Effect<DispatchResult, unknown, never> {
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
      let validated = result.value;

      // Per-dispatch abort plumbing. Effect-typed handlers also see
      // fiber interrupts; Promise/sync handlers see the AbortSignal.
      const controller = new AbortController();
      this.inFlight.set(input.toolCallId, { controller, toolName: input.name });

      const callerSignal = input.signal;
      const onCallerAbort = () => controller.abort(callerSignal?.reason);
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

      // ─── Confirmation gate ──────────────────────────────────────────
      // Tools annotated `requiresConfirmation: true` route through the
      // ElicitationHarness. The wire envelope is the standard elicitation
      // shape (session:channel:elicitation, hints.kind ===
      // "tool_confirmation"); the response is validated against
      // TOOL_CONFIRMATION_REPLY_SCHEMA. The harness retires its own
      // `session:channel:tool_confirmation` channel — one substrate
      // primitive, one wire shape.
      if (
        reg.declaration.annotations?.requiresConfirmation === true &&
        !this.alwaysAllowed.has(input.name)
      ) {
        const confirmationTimeoutMs =
          reg.declaration.annotations.confirmationTimeoutMs ??
          input.confirmationTimeoutMs ??
          this.defaultConfirmationTimeoutMs;

        // The signal flows through to the elicitation registry; an
        // inbox abort or caller signal abort settles the pending
        // elicit with `{ outcome: "failed", failure.kind: "aborted" }`.
        const elicit = this.elicitation.elicit(
          {
            message: `Approve tool "${input.name}"?`,
            schema: TOOL_CONFIRMATION_REPLY_SCHEMA,
            hints: { kind: TOOL_CONFIRMATION_KIND },
            metadata: {
              toolUseId: input.toolCallId,
              toolName: input.name,
              arguments: validated as Record<string, unknown>,
            },
          },
          {
            ...(confirmationTimeoutMs !== undefined ? { timeoutMs: confirmationTimeoutMs } : {}),
            signal: controller.signal,
          },
        );

        // `Effect.promise` bridges the elicit() Promise into the
        // surrounding Effect generator. elicit() never throws for
        // form-mode requests; URL-mode would throw but tool
        // confirmation only ever sends form-mode.
        const elicitResult = yield* Effect.promise(() => elicit);

        // Timeout → caller error so the loop sees it via
        // ToolConfirmationTimeoutError (existing contract).
        if (elicitResult.outcome === "failed" && elicitResult.failure.kind === "timeout") {
          return yield* Effect.fail({
            _tag: "ToolConfirmationTimeoutError",
            toolName: input.name,
            ms: confirmationTimeoutMs ?? 0,
          } as const);
        }

        // Approval requires accepted + reply.approved === true. Every
        // other path — declined, cancelled, failed.aborted,
        // failed.schema_violation, or accepted-with-approved-false —
        // is a denial.
        const reply = extractReply(elicitResult);
        const approved = reply?.approved === true;

        if (!approved) {
          callerSignal?.removeEventListener("abort", onCallerAbort);
          this.inFlight.delete(input.toolCallId);
          const denyReason = denialReason(elicitResult, reply);
          const denialResult: DispatchResult = {
            toolCallId: input.toolCallId,
            name: input.name,
            succeeded: false,
            content: [
              {
                type: "text",
                text: denyReason
                  ? `Tool "${input.name}" denied: ${denyReason}`
                  : `Tool "${input.name}" denied by user.`,
              },
            ],
            executedBy: "agentick",
            durationMs: 0,
          };
          return denialResult;
        }

        if (reply!.always === true) this.alwaysAllowed.add(input.name);

        // Re-validate when the host returns modifiedArguments — the
        // user may have edited the call before approving.
        if (reply!.modifiedArguments !== undefined) {
          const revalidated = yield* Effect.tryPromise({
            try: async () => entry.validator.validate(reply!.modifiedArguments),
            catch: (cause): { readonly _tag: "ToolValidationError"; readonly cause: unknown } => ({
              _tag: "ToolValidationError",
              cause,
            }),
          });
          if (isValidationFailure(revalidated)) {
            return yield* Effect.fail({
              _tag: "ToolValidationError",
              toolName: input.name,
              issues: revalidated.issues,
            } as const);
          }
          validated = revalidated.value;
        }
      }

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
      const invokeHandler = Effect.suspend(
        (): Effect.Effect<readonly ContentBlock[], unknown, never> => {
          if (controller.signal.aborted) {
            return Effect.fail(
              controller.signal.reason ?? {
                _tag: "ToolAbortedError",
                toolCallId: input.toolCallId,
              },
            );
          }
          const handlerResult = entry.handler(validated, { ctx, use: useDeps });

          // Abort watcher — fails the race when the dispatch
          // controller fires (caller abort or timeout). Shared between
          // the Effect and Promise handler shapes so both paths get
          // identical abort semantics.
          const abortEff: Effect.Effect<never, unknown, never> = Effect.async<
            never,
            unknown,
            never
          >((resume) => {
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
            return Effect.sync(() => controller.signal.removeEventListener("abort", onAbort));
          });

          if (isEffect(handlerResult)) {
            // Effect-typed handler yields IN the parent fiber so it
            // inherits the `RuntimeContextRef` FiberRef set by
            // `runOperation`. `Effect.raceFirst` (not `race`) — settles
            // on the first to either succeed OR fail. `Effect.race`
            // waits for a success and would let a finishing handler
            // beat an already-fired abort.
            return Effect.raceFirst(handlerResult, abortEff);
          }

          if (isPromiseLike(handlerResult)) {
            // Lift the Promise to Effect and race against the same
            // abort watcher used by the Effect path — eliminates the
            // hand-rolled `abortPromise` Promise.race bridge.
            const handlerEff = Effect.tryPromise({
              try: () => handlerResult as PromiseLike<readonly ContentBlock[]>,
              catch: (cause: unknown) => cause,
            });
            return Effect.raceFirst(handlerEff, abortEff);
          }

          return Effect.succeed(handlerResult);
        },
      );

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
        ? (controller.signal.reason ?? rawErr)
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

function isTaggedAbort(value: unknown): value is { readonly _tag: string } {
  if (value === null || typeof value !== "object") return false;
  const tag = (value as { _tag?: unknown })._tag;
  return tag === "ToolAbortedError" || tag === "ToolTimeoutError";
}

function isEffect(value: unknown): value is Effect.Effect<readonly ContentBlock[], unknown, never> {
  return typeof value === "object" && value !== null && Effect.EffectTypeId in value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isTaggedToolError(value: unknown): value is { readonly _tag: string } {
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

/**
 * Pull the validated reply out of an `accepted` elicitation result.
 * Returns `undefined` for any other outcome.
 */
function extractReply(
  result:
    | { readonly outcome: "accepted"; readonly value: ToolConfirmationReply }
    | { readonly outcome: "declined"; readonly reason?: string }
    | { readonly outcome: "cancelled"; readonly reason?: string }
    | {
        readonly outcome: "failed";
        readonly failure: { readonly kind: string; readonly reason?: string };
      },
): ToolConfirmationReply | undefined {
  return result.outcome === "accepted" ? result.value : undefined;
}

/**
 * Compose a denial reason from the available signals: the user's
 * `accepted+approved:false` reason, declined/cancelled reason, or a
 * failure-kind label.
 */
function denialReason(
  result:
    | { readonly outcome: "accepted"; readonly value: ToolConfirmationReply }
    | { readonly outcome: "declined"; readonly reason?: string }
    | { readonly outcome: "cancelled"; readonly reason?: string }
    | {
        readonly outcome: "failed";
        readonly failure: { readonly kind: string; readonly reason?: string };
      },
  reply: ToolConfirmationReply | undefined,
): string | undefined {
  if (reply !== undefined) return reply.reason;
  if (result.outcome === "declined" || result.outcome === "cancelled") return result.reason;
  if (result.outcome === "failed") return result.failure.reason ?? result.failure.kind;
  return undefined;
}

// Silence unused-import linting until 4a.6+ uses ToolRegistration alias.
void (undefined as unknown as ToolRegistration);
