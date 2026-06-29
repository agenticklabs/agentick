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

import { omitUndefined } from "@agentick/utils-next";

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
  RemoveBoundToolsInput,
  ReplaceReconcilerToolsInput,
  TaskHandle,
  TasksHarnessProtocol,
  ToolDeclaration,
  ToolExecutorInboxMessage,
  ToolExecutorProtocol,
  ToolListFilter,
  ToolRegistration,
  UnregisterToolInput,
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";

import {
  TOOL_CONFIRMATION_KIND,
  TOOL_CONFIRMATION_REPLY_SCHEMA,
  type ToolConfirmationReply,
} from "./confirmation-schema.js";
import { InMemoryToolRegistry, sameBindingKey } from "./registry.js";
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
  private readonly tasks: TasksHarnessProtocol | undefined;

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
    this.tasks = options.tasks;

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

  removeBoundTools(input: RemoveBoundToolsInput): Promise<void> {
    const op: Operation<RemoveBoundToolsInput, void> = {
      opId: input.opId ?? `tool:remove-bound:${input.binding.scope}:${ulid()}`,
      surface: "tool",
      name: "tool:command:remove-bound-tools",
      scope: {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.registry.removeWhere((b) => sameBindingKey(b, i.binding));
        }),
      ),
    );
  }

  replaceReconcilerTools(input: ReplaceReconcilerToolsInput): Promise<void> {
    const op: Operation<ReplaceReconcilerToolsInput, void> = {
      opId: input.opId ?? `tool:replace-reconciler:${input.mountId}:${ulid()}`,
      surface: "tool",
      name: "tool:command:replace-reconciler-tools",
      scope: {},
      input,
    };
    // `Effect.try` (not `.sync`) — binding validation throws on
    // mismatch; we want those to surface as tagged failures the
    // caller can catch, not defects that crash the fiber.
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.try({
          try: () => this.registry.replaceReconcilerSlice(i.mountId, i.registrations),
          catch: (cause) => cause,
        }),
      ),
    );
  }

  /**
   * Per-tick compile — precedence-resolved tool set. Pure read,
   * bypasses `runOperation` (no journal pollution). Filter is applied
   * BEFORE precedence resolution so a high-precedence registration
   * that fails the filter doesn't shadow a lower-precedence one that
   * passes — matching only competes among rows the filter admits.
   */
  async compileForTick(filter?: ToolListFilter): Promise<readonly ToolDeclaration[]> {
    return this.registry.compileForTick(filter);
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
      return Effect.fail(
        new HandlerError({ cause: new Error("tool inbox: payload missing or untagged") }),
      );
    }
    switch (payload.type) {
      case "abort":
        return Effect.sync(() => {
          this.abortInFlight(payload.toolCallId, payload.reason);
        });
      default: {
        const unknownType = (payload as { type: string }).type;
        return Effect.fail(
          new HandlerError({
            cause: new Error(`tool inbox: unknown message type "${unknownType}"`),
          }),
        );
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

      // Pre-flight: explicit `task` overrides that contradict the
      // tool's declared `taskSupport` are surfaced as
      // `ToolTaskModeConflictError` before the handler runs. The
      // matrix:
      //
      //   - `"ref"` + supportMode "unsupported" — the handler is not
      //     expected to produce a TaskHandle; there is no ref to
      //     return.
      //   - `"inline"` + supportMode "required" — the contract says
      //     the tool must run as a task across ticks; awaiting it
      //     inline defeats the point.
      //
      // `"auto"` never conflicts at pre-flight; the executor resolves
      // it on the resolved-value side.
      {
        const supportMode = reg.declaration.annotations?.taskSupport ?? "unsupported";
        const requestedTaskMode = input.task ?? "auto";
        if (requestedTaskMode === "ref" && supportMode === "unsupported") {
          return yield* Effect.fail({
            _tag: "ToolTaskModeConflictError",
            toolName: input.name,
            requestedTaskMode: "ref",
            supportMode: "unsupported",
          } as const);
        }
        if (requestedTaskMode === "inline" && supportMode === "required") {
          return yield* Effect.fail({
            _tag: "ToolTaskModeConflictError",
            toolName: input.name,
            requestedTaskMode: "inline",
            supportMode: "required",
          } as const);
        }
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
            ...omitUndefined({ timeoutMs: confirmationTimeoutMs }),
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
        ...omitUndefined({
          sessionId: input.context.sessionId,
          executionId: input.context.executionId,
          tickId: input.context.tickId,
        }),
        signal: controller.signal,
        // Resolved task mode for THIS dispatch (#174). Mirrors
        // `DispatchInput.task` after default → `"auto"`. Handlers
        // with a sync-or-task choice (MCP `supported` tools) read
        // this to decide per-call whether to take the task wire.
        // Pre-flight conflicts (e.g. `"ref"` against `"unsupported"`)
        // were already rejected above, so this value is always
        // valid for the resolved tool's `taskSupport`.
        task: input.task ?? "auto",
        // Substrate primitives surfaced for ad-hoc handler use
        // (`ctx.elicitation.elicit(...)`, `ctx.tasks.submit(...)`).
        // Always present in production; the optional spec field
        // covers test fixtures that omit them.
        elicitation: this.elicitation,
        ...omitUndefined({ tasks: this.tasks }),
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
                ...omitUndefined({ metadata: seed.metadata }),
                parentOpId: opIdForCausality,
                scope: {
                  ...omitUndefined({
                    sessionId: input.context.sessionId,
                    executionId: input.context.executionId,
                    tickId: input.context.tickId,
                  }),
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

          // Branch by handler shape. Effect and Promise paths
          // resolve to a value that MAY be a `TaskHandle`; we
          // post-process for the TaskHandle branch below. The sync
          // path checks isTaskHandle directly.
          //
          // For async handlers (the common case) — `handlerResult`
          // is a `Promise<TaskHandle | ContentBlock[]>`. We await
          // the promise first via the existing race-with-abort, THEN
          // dispatch to the TaskHandle branch if the resolved value
          // is a handle.
          //
          // Pattern A vs Pattern B is decided by combining the
          // tool's declared `taskSupport` with the caller's `task`
          // option (default `"auto"`):
          //
          //   - explicit `"ref"`  → Pattern B (returns
          //     `session_task_ref`). Pre-flight rejects when
          //     supportMode === "unsupported".
          //   - explicit `"inline"` → Pattern A (await handle). Pre-
          //     flight rejects when supportMode === "required".
          //   - `"auto"` + `via: "model"` + supportMode "required"
          //     → Pattern B (the model-tick path keeps required
          //     tools async across ticks).
          //   - every other `"auto"` combination → Pattern A
          //     (host-side default; Phase C #174 refines the
          //     "supported" branch with capability negotiation).
          const supportMode = reg.declaration.annotations?.taskSupport ?? "unsupported";
          const requestedTaskMode = input.task ?? "auto";

          const dispatchOnResolved = (
            resolved: unknown,
          ): Effect.Effect<readonly ContentBlock[], unknown, never> => {
            if (!isTaskHandle(resolved)) {
              return Effect.succeed(resolved as readonly ContentBlock[]);
            }

            const usePatternB =
              requestedTaskMode === "ref" ||
              (requestedTaskMode === "auto" &&
                input.context.via === "model" &&
                supportMode === "required");

            if (usePatternB) {
              // Wire the dispatch's abort signal to the task's
              // cancel — caller abort propagates to the task.
              if (controller.signal.aborted) {
                void resolved.cancel("dispatch_aborted");
              } else {
                controller.signal.addEventListener(
                  "abort",
                  () => {
                    void resolved.cancel("dispatch_aborted");
                  },
                  { once: true },
                );
              }
              return Effect.succeed(serializeTaskRef(resolved));
            }

            // Pattern A — await the handle's result. Abort the task
            // on dispatch abort so we don't orphan in-flight work.
            const cancelOnAbort = (): void => {
              void resolved.cancel("dispatch_aborted");
            };
            if (controller.signal.aborted) {
              cancelOnAbort();
            } else {
              controller.signal.addEventListener("abort", cancelOnAbort, { once: true });
            }
            const taskAwaitEff = Effect.tryPromise({
              try: () => resolved.result as Promise<readonly ContentBlock[]>,
              catch: (cause: unknown) => cause,
            });
            return Effect.raceFirst(taskAwaitEff, abortEff);
          };

          if (isTaskHandle(handlerResult)) {
            // Sync return of a TaskHandle (non-async handler).
            return dispatchOnResolved(handlerResult);
          }

          if (isEffect(handlerResult)) {
            // Effect-typed handler yields IN the parent fiber so it
            // inherits the `RuntimeContextRef` FiberRef set by
            // `runOperation`. `Effect.raceFirst` (not `race`) —
            // settles on the first to either succeed OR fail.
            // `flatMap` post-processes the resolved value for the
            // TaskHandle branch.
            return Effect.flatMap(
              Effect.raceFirst(handlerResult as Effect.Effect<unknown, unknown, never>, abortEff),
              dispatchOnResolved,
            );
          }

          if (isPromiseLike(handlerResult)) {
            // Lift the Promise to Effect, race against the abort
            // watcher, then dispatch the resolved value (which may
            // be a TaskHandle from an async handler that
            // `return ctx.tasks.submit(...)`-ed).
            const handlerEff = Effect.tryPromise({
              try: () => handlerResult as PromiseLike<unknown>,
              catch: (cause: unknown) => cause,
            });
            return Effect.flatMap(Effect.raceFirst(handlerEff, abortEff), dispatchOnResolved);
          }

          // Sync, non-TaskHandle return — pass through. TS can't
          // narrow across the disjoint branches above, so cast
          // explicitly: at this point handlerResult is a sync
          // `readonly ContentBlock[]` (Effect/Promise/TaskHandle
          // cases already returned).
          return Effect.succeed(handlerResult as readonly ContentBlock[]);
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

/**
 * Structural test for a `TaskHandle` return shape. The handle has
 * `taskId` (string), `initialStatus` (string), and `result`
 * (Promise) — three required fields rules out plain objects /
 * ContentBlock arrays / Effects / Promises.
 *
 * Promises are excluded explicitly (a Promise has `.then` but no
 * `.taskId`); the `isPromiseLike` branch downstream handles those.
 */
function isTaskHandle(value: unknown): value is TaskHandle<readonly ContentBlock[]> {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<TaskHandle<readonly ContentBlock[]>>;
  return (
    typeof v.taskId === "string" &&
    typeof v.initialStatus === "string" &&
    typeof (v as { result?: unknown }).result === "object" &&
    typeof v.cancel === "function"
  );
}

/**
 * Build the first-class {@link TaskRefBlock} the model receives in
 * lieu of the eventual result when a tool resolves to a task handle
 * (Pattern B). The block-type discriminator (`type: "task_ref"`)
 * lives on the block itself — consumers pattern-match via `block.type`
 * rather than JSON-parsing a text body for a magic `_kind` field.
 *
 * The framework-side projection to text-JSON (drop-in compatibility
 * with the prior `_kind: "session_task_ref"` JSON shape) happens at
 * the executor boundary in `messagePartFromBlock`. That keeps the
 * block-type first-class WITHIN the framework while preserving the
 * exact wire shape adopters parse today.
 */
function serializeTaskRef(handle: TaskHandle<readonly ContentBlock[]>): readonly ContentBlock[] {
  const info = handle.info();
  return [
    {
      type: "task_ref",
      taskId: info.taskId,
      status: info.status,
      ...omitUndefined({ statusMessage: info.statusMessage }),
      ...(info.ttl !== null && info.ttl !== undefined ? { ttl: info.ttl } : {}),
      ...omitUndefined({ pollInterval: info.pollInterval }),
    } satisfies ContentBlock,
  ];
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
