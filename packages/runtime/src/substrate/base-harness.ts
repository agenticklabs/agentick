/**
 * BaseHarness — the inheritance point every concrete harness sits on.
 *
 * Composes journal + bus + inbox into the five-surface model:
 *
 *   ① Commands     — `runOperation` (heavy path with phase contract,
 *                    idempotency, journaling, observability)
 *   ② Inbox        — `handleMessage` (concrete subclass implements)
 *   ③ Lifecycle    — `.on*(fn)` via HandlerRegistry
 *   ④ Middleware   — `.use(mw)` via MiddlewareChain
 *   ⑤ Events       — `emit` (light path) + `emitDelta` (in-flight)
 *
 * Substrate-internal API is Effect-typed end-to-end. Concrete harnesses
 * MAY expose Promise-typed protocol surfaces (e.g., ReconcilerProtocol)
 * by wrapping their command bodies with `Effect.runPromise` at the
 * public method boundary. The FiberRef scope (`RuntimeContextRef`) is
 * established by `runOperation` for the lifetime of the command — any
 * Effect launched within the body sees the active sessionId,
 * executionId, tickId, opId, parentOpId, correlationId via `getContext`.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §`BaseHarness` — the inheritance point
 * @see docs/proposals/v2/blueprint/01-harness-principle.md
 */

import { Cause, Effect, Exit, Option } from "effect";
import type {
  CommandOutcome,
  EventBus,
  EventPhase,
  EventScope,
  EventSurface,
  HandlerVerdict,
  InboxError,
  JournalError,
  JournalingPolicy,
  LifecycleHandlerError,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  ProtocolEvent,
  SubstrateError,
  TerminalEvent,
  Unsubscribe,
} from "@agentick/spec";
import { DEFAULT_JOURNALING_POLICY } from "@agentick/spec";
import { ulid } from "./ulid.js";
import { getContext, type RuntimeContext, withContext } from "./runtime-context.js";
import { RequestResponseRegistry, type RequestError } from "./request-response-registry.js";

export type { Unsubscribe } from "@agentick/spec";

/**
 * Lifecycle handler. Runs at a phase boundary (typically `before`); may
 * return a {@link HandlerVerdict} to influence command execution.
 *
 * Returning `void` is equivalent to `{ kind: "proceed" }`.
 */
export type LifecycleHandler<I = unknown, R = unknown, E = never> = (
  input: I,
) => Effect.Effect<HandlerVerdict<R> | void, E, never>;

/**
 * Middleware. Wraps the command body — invoke `next(input)` to proceed
 * or return a value to short-circuit. Composes outer→inner: the first
 * middleware registered is the outermost.
 */
export type Middleware<I = unknown, R = unknown, E = unknown> = (
  input: I,
  next: (input: I) => Effect.Effect<R, E, never>,
) => Effect.Effect<R, E, never>;

// ============================================================================
// HandlerRegistry — keyed handler lists
// ============================================================================

export class HandlerRegistry {
  private handlers = new Map<string, LifecycleHandler<unknown, unknown, unknown>[]>();

  register<I, R, E = never>(key: string, handler: LifecycleHandler<I, R, E>): Unsubscribe {
    const list = this.handlers.get(key) ?? [];
    list.push(handler as LifecycleHandler<unknown, unknown, unknown>);
    this.handlers.set(key, list);
    return () => {
      const current = this.handlers.get(key);
      if (!current) return;
      const idx = current.indexOf(handler as LifecycleHandler<unknown, unknown, unknown>);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  /**
   * Run all handlers for `key` in registration order. Returns the merged
   * verdict per: veto > replace > defer > proceed.
   *
   * Handler failures propagate through the `E` channel.
   */
  run<I, R>(key: string, input: I): Effect.Effect<HandlerVerdict<R>, unknown, never> {
    const list = this.handlers.get(key) ?? [];
    return Effect.gen(function* () {
      let merged: HandlerVerdict<R> = { kind: "proceed" };
      for (const h of list) {
        const raw = yield* h(input) as Effect.Effect<HandlerVerdict<R> | void, unknown, never>;
        const v = (raw ?? { kind: "proceed" }) as HandlerVerdict<R>;
        merged = mergeVerdict(merged, v);
        if (merged.kind === "veto") return merged;
      }
      return merged;
    });
  }
}

/**
 * Verdict merge rule: veto > replace > defer > proceed.
 * First-veto wins; first-replace wins; deferreds use earliest retry.
 */
export function mergeVerdict<R>(a: HandlerVerdict<R>, b: HandlerVerdict<R>): HandlerVerdict<R> {
  if (a.kind === "veto") return a;
  if (b.kind === "veto") return b;
  if (a.kind === "replace") return a;
  if (b.kind === "replace") return b;
  if (a.kind === "defer" && b.kind === "defer") {
    const ra = a.retryAfter;
    const rb = b.retryAfter;
    if (ra === undefined) return b;
    if (rb === undefined) return a;
    return { kind: "defer", retryAfter: Math.min(ra, rb) };
  }
  if (a.kind === "defer") return a;
  if (b.kind === "defer") return b;
  return { kind: "proceed" };
}

// ============================================================================
// MiddlewareChain — outer→inner composition
// ============================================================================

export class MiddlewareChain {
  private middlewares: Middleware<unknown, unknown, unknown>[] = [];

  use<I, R, E = unknown>(mw: Middleware<I, R, E>): Unsubscribe {
    this.middlewares.push(mw as Middleware<unknown, unknown, unknown>);
    return () => {
      const idx = this.middlewares.indexOf(mw as Middleware<unknown, unknown, unknown>);
      if (idx >= 0) this.middlewares.splice(idx, 1);
    };
  }

  /**
   * Compose middlewares around a body. The first registered is outermost.
   */
  compose<I, R, E>(
    body: (input: I) => Effect.Effect<R, E, never>,
  ): (input: I) => Effect.Effect<R, E, never> {
    const list = this.middlewares.slice() as Middleware<I, R, E>[];
    return list.reduceRight<(input: I) => Effect.Effect<R, E, never>>(
      (next, mw) => (input) => mw(input, next),
      body,
    );
  }
}

// ============================================================================
// BaseHarness
// ============================================================================

export interface BaseHarnessOptions {
  readonly policy?: JournalingPolicy;
  /**
   * Auto-register on the inbox at construction. Set false for harnesses
   * that handle their own registration timing. Default: true.
   */
  readonly autoRegisterInbox?: boolean;
}

export abstract class BaseHarness<Surface extends EventSurface = EventSurface> {
  protected readonly address: string;
  protected readonly handlers = new HandlerRegistry();
  protected readonly middleware = new MiddlewareChain();
  /**
   * In-flight request/response correlation map. Every BaseHarness can
   * issue `this.request(channel, payload)` and receives `request-response`
   * inbox messages routed automatically by `dispatchMessage` before
   * the subclass's `handleMessage` is consulted.
   */
  protected readonly requests = new RequestResponseRegistry<unknown>();
  private readonly policy: JournalingPolicy;
  private inboxUnsubscribe?: Unsubscribe;

  /**
   * Resolves once the harness has finished its async construction tasks
   * (inbox registration). Callers that need to send inbox messages to
   * this harness immediately after construction MUST `await
   * harness.ready` first — otherwise `inbox.send(address, ...)` may race
   * against registration and fail with `AddressNotFound`.
   *
   * Resolves immediately when `autoRegisterInbox: false`.
   */
  readonly ready: Promise<void>;

  /**
   * Register an around-style middleware that wraps every operation
   * the harness routes through `runOperation`. Composition is
   * outer→inner — the first registered is the outermost wrap.
   * Returns an `Unsubscribe` to remove it.
   *
   * Note: this is the universal surface. Harnesses whose *public*
   * commands don't currently go through `runOperation`
   * (`SessionHarness.send`, `AppHarness.createSession`, etc.) will
   * accept registrations but those operations won't be wrapped until
   * they're refactored to use `runOperation`.
   */
  use<I = unknown, R = unknown, E = unknown>(mw: Middleware<I, R, E>): Unsubscribe {
    return this.middleware.use(mw as Middleware<unknown, unknown, unknown>);
  }

  constructor(
    protected readonly surface: Surface,
    protected readonly scopeId: string,
    protected readonly journal: OperationJournal,
    protected readonly bus: EventBus,
    protected readonly inbox: MessageInbox,
    options: BaseHarnessOptions = {},
  ) {
    this.address = `${surface}:${scopeId}`;
    this.policy = options.policy ?? DEFAULT_JOURNALING_POLICY;
    if (options.autoRegisterInbox !== false) {
      // Register is async — cluster impls may negotiate across nodes.
      // Local impls resolve immediately. Either way, `ready` is the
      // deterministic readiness handle.
      this.ready = Effect.runPromise(
        this.inbox.register(this.address, (msg) => this.dispatchMessage(msg)),
      ).then((unsub) => {
        this.inboxUnsubscribe = unsub;
      });
    } else {
      this.ready = Promise.resolve();
    }
  }

  // ──────── ① Commands (heavy path) ────────

  /**
   * Run an operation through the full phase contract:
   *
   *   idempotency check → requested → before (handlers + middleware) →
   *   body → terminal
   *
   * Succeeds with the operation's result. Failures and non-success
   * terminals (failed, canceled, vetoed, deferred) flow through the `E`
   * channel as `OperationOutcomeError` (carrying the typed terminal)
   * unless the body's own error type is preserved on the failed path.
   *
   * The harness establishes the `RuntimeContextRef` FiberRef for the
   * lifetime of the command — sessionId/executionId/tickId/opId/
   * parentOpId/correlationId from `op.scope` are visible to any
   * downstream Effect via `getContext`.
   */
  protected runOperation<I, R, E>(
    op: Operation<I, R, E>,
    body: (input: I) => Effect.Effect<R, E, never>,
  ): Effect.Effect<R, E | SubstrateError, never> {
    return Effect.gen(this, function* () {
      // Auto-set parentOpId from the surrounding FiberRef when the caller
      // didn't supply one. This is what makes nested `runOperation`
      // calls compose into a causality tree without app code threading
      // parentOpId by hand.
      const ambient = yield* getContext;
      const resolvedOp: Operation<I, R, E> =
        op.parentOpId === undefined && ambient.opId !== undefined
          ? { ...op, parentOpId: ambient.opId }
          : op;

      const scope: EventScope = resolvedOp.scope ?? {};
      const ctxScope: RuntimeContext = {
        sessionId: scope.sessionId,
        executionId: scope.executionId,
        tickId: scope.tickId,
        opId: resolvedOp.opId,
        parentOpId: resolvedOp.parentOpId,
        correlationId: resolvedOp.correlationId,
      };

      return yield* withContext(
        ctxScope,
        Effect.scoped(
          Effect.gen(this, function* () {
            // 1. Idempotency: replay terminal if op already completed.
            const cached = yield* this.journal.lookupTerminal(resolvedOp.opId);
            if (cached.some) {
              return yield* this.replayTerminal<R>(cached.value);
            }

            // 2. Append `requested`.
            yield* this.publish(this.makeEvent(resolvedOp, "requested", scope));

            // 3. Append `before` and run handlers.
            yield* this.publish(this.makeEvent(resolvedOp, "before", scope));
            const verdictExit = yield* Effect.exit(
              this.handlers.run<I, R>("before", resolvedOp.input),
            );
            if (Exit.isFailure(verdictExit)) {
              const cause = Cause.failureOption(verdictExit.cause);
              const lifecycleErr: LifecycleHandlerError = {
                _tag: "LifecycleHandlerError",
                phase: "before",
                cause: Option.isSome(cause) ? cause.value : verdictExit.cause,
              };
              yield* this.publishTerminal(resolvedOp, scope, "failed", {
                error: this.normalizeError(lifecycleErr),
              });
              return yield* Effect.fail<SubstrateError>(lifecycleErr);
            }
            const verdict = verdictExit.value as HandlerVerdict<R>;
            switch (verdict.kind) {
              case "veto":
                return yield* this.terminate<R>(resolvedOp, scope, "vetoed", {
                  reason: verdict.reason,
                });
              case "replace":
                return yield* this.terminate<R>(resolvedOp, scope, "replaced", {
                  result: verdict.result,
                  reason: verdict.reason,
                });
              case "defer":
                return yield* this.terminate<R>(resolvedOp, scope, "deferred", {
                  retryAfter: verdict.retryAfter,
                });
              case "proceed":
                break;
            }

            // 4. Compose middleware around body, execute. We capture
            //    the body's exit so the span integration (below) can
            //    annotate attributes without going through
            //    `Effect.withSpan` — which we found copies failures
            //    when it captures them, breaking error-reference
            //    identity in adopters' typed error channels.
            const composed = this.middleware.compose<I, R, E>(body);
            return yield* composed(resolvedOp.input).pipe(
              Effect.tap((value) =>
                this.publishTerminal(resolvedOp, scope, "succeeded", { result: value }),
              ),
              Effect.tapError((err) =>
                this.publishTerminal(resolvedOp, scope, "failed", {
                  error: this.normalizeError(err),
                }),
              ),
              // Span annotation: attributes carry through whether the
              // operation succeeded or failed. The span's recordException
              // path runs on the captured Exit only — the failure value
              // returned to the caller is untouched.
              this.annotateOperationSpan(resolvedOp),
            );
          }),
        ),
      );
    });
  }

  /**
   * Span attributes attached to every operation's OTel span. Exporters
   * (subscribed via `@effect/opentelemetry`) see these on the span.
   * Override in concrete harnesses to add domain attributes.
   */
  protected spanAttributes(
    op: Operation<unknown, unknown, unknown>,
  ): Readonly<Record<string, unknown>> {
    const scope = op.scope ?? {};
    return {
      "agentick.op_id": op.opId,
      "agentick.surface": op.surface,
      "agentick.parent_op_id": op.parentOpId,
      "agentick.correlation_id": op.correlationId,
      "agentick.session_id": scope.sessionId,
      "agentick.execution_id": scope.executionId,
      "agentick.tick_id": scope.tickId,
    };
  }

  /**
   * Wrap an Effect in an OTel span using the standard `Effect.withSpan`.
   *
   * Effect's `withSpan` enhances failure stack traces with span context
   * by reconstructing top-level failure values (the outer object the
   * effect failed with). Inner Error references and tagged-union
   * fields like `.cause` are preserved as-is — deep-equality, instanceof,
   * `_tag` matching, and property-based access all work normally. Only
   * a top-level `=== originalError` identity check on the outer failure
   * object will see a different reference. Adopters who need such
   * identity matching should reach for `_tag` or `instanceof` instead.
   *
   * @see docs/proposals/v2/blueprint/17-open-questions.md §L5
   */
  private annotateOperationSpan<A, E>(
    op: Operation<unknown, unknown, unknown>,
  ): (eff: Effect.Effect<A, E, never>) => Effect.Effect<A, E, never> {
    const attributes = this.spanAttributes(op);
    return (eff) => eff.pipe(Effect.withSpan(op.name, { attributes }));
  }

  // ──────── ⑤ Events (light path) ────────

  /**
   * Emit a discrete event. No phase contract, no idempotency.
   *
   * The envelope construction is unconditional because discrete events
   * may be journaled (per policy `alwaysJournal` / per-name overrides).
   * For surface-scoped notifications with no journaling expectation,
   * concrete harnesses should call `emitLazy` instead — it probes the
   * bus subscriber index and skips envelope construction when nobody
   * is listening.
   */
  protected emit(
    args: Omit<ProtocolEvent, "id" | "timestamp" | "surface"> & { readonly id?: string },
  ): Effect.Effect<void, JournalError, never> {
    const envelope: ProtocolEvent = {
      ...args,
      id: args.id ?? ulid(),
      timestamp: Date.now(),
      surface: this.surface,
    };
    return this.publish(envelope);
  }

  /**
   * Construction-on-demand variant of `emit`. The `build` thunk runs
   * ONLY if the policy decision routes to a journal write OR the bus
   * has at least one subscriber that could match `key`. For pure
   * bus-only notifications with no journaling expectation, this is
   * the cheap path — the cost is one map lookup when nobody is
   * listening.
   *
   * Always-journal phases still require an envelope, so we invoke the
   * thunk regardless. Bus-only phases skip the thunk when
   * `bus.hasSubscriber` is false.
   */
  protected emitLazy(
    key: { readonly name: string; readonly phase: EventPhase },
    build: () => Omit<ProtocolEvent, "id" | "timestamp" | "surface"> & {
      readonly id?: string;
    },
  ): Effect.Effect<void, JournalError, never> {
    const decision = this.decideFromShape(key.name, key.phase);
    if (decision === "drop") return Effect.void;
    if (decision === "always" || decision === "journal") {
      // Journal needs the envelope regardless of subscribers.
      return this.emit(build());
    }
    // bus-only — probe the subscriber index first.
    if (!this.bus.hasSubscriber({ surface: this.surface, name: key.name, phase: key.phase })) {
      return Effect.void;
    }
    return this.emit(build());
  }

  /**
   * Streaming progress within an active operation. Delta envelopes are
   * by default bus-only (per `DEFAULT_JOURNALING_POLICY`) — they don't
   * hit the journal unless an override flips the policy. The lazy
   * variant `emitDeltaLazy` is the recommended path for hot streams
   * (model tokens, dense sandbox output) where the delta payload may
   * cost meaningful CPU to construct.
   */
  protected emitDelta(
    op: Operation<unknown, unknown, unknown>,
    payload: unknown,
  ): Effect.Effect<void, JournalError, never> {
    return this.publish(this.makeEvent(op, "delta", op.scope ?? {}, { payload }));
  }

  /**
   * Construction-on-demand delta emission. The `buildPayload` thunk
   * runs only when the policy demands journaling OR a subscriber wants
   * the envelope. Hot publishers (streaming model tokens, dense
   * sandbox stdout) should prefer this form so they don't pay payload
   * construction when no observer is listening.
   */
  protected emitDeltaLazy(
    op: Operation<unknown, unknown, unknown>,
    buildPayload: () => unknown,
  ): Effect.Effect<void, JournalError, never> {
    const decision = this.decideFromShape(op.name, "delta");
    if (decision === "drop") return Effect.void;
    if (decision === "always" || decision === "journal") {
      return this.publish(this.makeEvent(op, "delta", op.scope ?? {}, { payload: buildPayload() }));
    }
    if (
      !this.bus.hasSubscriber({
        surface: op.surface ?? this.surface,
        name: op.name,
        phase: "delta",
      })
    ) {
      return Effect.void;
    }
    return this.publish(this.makeEvent(op, "delta", op.scope ?? {}, { payload: buildPayload() }));
  }

  // ──────── ② Inbox dispatch ────────

  /**
   * Concrete harnesses override this with a typed switch on message.type.
   * Default: reject with `HandlerError`.
   */
  protected abstract handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never>;

  private dispatchMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    // Auto-intercept `request-response` messages BEFORE the subclass
    // sees them. The payload's `correlationId` routes to the pending
    // Deferred via the registry. Subclasses never see these.
    if (msg.type === "request-response") {
      return Effect.sync(() => {
        const payload = msg.payload as { correlationId?: string; response?: unknown } | undefined;
        if (
          payload &&
          typeof payload.correlationId === "string" &&
          this.requests.has(payload.correlationId)
        ) {
          this.requests.resolve(payload.correlationId, payload.response);
        }
        // Unknown correlationId is non-fatal — stale response after
        // timeout or after the registry was cleared. Log-only behavior
        // surfaces via the regular `HandlerError` path in a follow-up.
      });
    }
    return this.handleMessage(msg).pipe(
      Effect.catchAll((cause) => Effect.fail<MessageHandlerError>({ _tag: "HandlerError", cause })),
    );
  }

  // ──────── request/response (block 5) ────────

  /**
   * Send a request on a channel and await a correlated response.
   *
   * Publishes a channel envelope tagged with a correlationId + replyTo
   * (this harness's inbox address). Subscribers (in-process via
   * `channel.onRequest`, or out-of-process via gateway) deliver a
   * `request-response` inbox message back here, which auto-routes to
   * the pending Deferred via `this.requests`.
   *
   * `[V1-INHERITED]` — generalizes v1's `ToolConfirmationCoordinator`
   * across all harnesses. Tool confirmation refactors onto this.
   */
  protected request<TReq, TResp>(
    channel: string,
    payload: TReq,
    opts: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Effect.Effect<TResp, RequestError, never> {
    const correlationId = `req:${ulid()}`;
    const replyTo = this.address;
    const registered = this.requests.register({
      correlationId,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    // Publish the request envelope on the bus. The channel name pattern
    // matches `ChannelHandle.publish` — `session:channel:<channel>`.
    const fullName = `session:channel:${channel}`;
    const envelope: ProtocolEvent = {
      id: ulid(),
      surface: "session",
      name: fullName,
      phase: "delta",
      timestamp: Date.now(),
      scope: {},
      payload,
      metadata: {
        requestType: "request",
        correlationId,
        replyTo,
      },
    } as ProtocolEvent;
    return Effect.flatMap(this.bus.publish(envelope), () =>
      Effect.tryPromise<TResp, RequestError>({
        try: () => registered.promise as Promise<TResp>,
        catch: (cause): RequestError => cause as RequestError,
      }),
    );
  }

  // ──────── lifecycle ────────

  /** Detach this harness from the inbox. */
  async close(): Promise<void> {
    if (this.inboxUnsubscribe) {
      this.inboxUnsubscribe();
      this.inboxUnsubscribe = undefined;
    }
  }

  // ──────── helpers ────────

  private makeEvent(
    op: Operation<unknown, unknown, unknown>,
    phase: EventPhase,
    scope: EventScope,
    extra?: { payload?: unknown; outcome?: CommandOutcome; error?: ProtocolEvent["error"] },
  ): ProtocolEvent {
    return {
      id: ulid(),
      opId: op.opId,
      surface: op.surface ?? this.surface,
      name: op.name,
      phase,
      timestamp: Date.now(),
      scope,
      payload: extra?.payload,
      outcome: extra?.outcome,
      error: extra?.error,
    } as ProtocolEvent;
  }

  private terminate<R>(
    op: Operation<unknown, R, unknown>,
    scope: EventScope,
    outcome: CommandOutcome,
    payload: Record<string, unknown>,
  ): Effect.Effect<R, OperationOutcomeError | JournalError, never> {
    return Effect.gen(this, function* () {
      yield* this.publishTerminal(op, scope, outcome, payload);
      return yield* this.replayTerminal<R>(this.payloadToTerminal(outcome, payload));
    });
  }

  /**
   * Publish-only terminal — emits the `terminal` envelope but does not
   * raise OperationOutcomeError. Used on the failure path where the
   * caller wants to re-raise the original error after journaling.
   */
  private publishTerminal(
    op: Operation<unknown, unknown, unknown>,
    scope: EventScope,
    outcome: CommandOutcome,
    payload: Record<string, unknown>,
  ): Effect.Effect<void, JournalError, never> {
    const error = outcome === "failed" ? (payload.error as ProtocolEvent["error"]) : undefined;
    const envelope = this.makeEvent(op, "terminal", scope, { payload, outcome, error });
    return this.publish(envelope);
  }

  private payloadToTerminal(
    outcome: CommandOutcome,
    payload: Record<string, unknown>,
  ): TerminalEvent {
    switch (outcome) {
      case "succeeded":
        return { outcome, result: payload.result };
      case "failed":
        return { outcome, error: payload.error };
      case "canceled":
        return { outcome, reason: payload.reason as string | undefined };
      case "vetoed":
        return { outcome, reason: payload.reason as string | undefined };
      case "replaced":
        return {
          outcome,
          result: payload.result,
          reason: payload.reason as string | undefined,
        };
      case "deferred":
        return {
          outcome,
          retryAfter: payload.retryAfter as number | undefined,
        };
    }
  }

  private replayTerminal<R>(
    terminal: TerminalEvent,
  ): Effect.Effect<R, OperationOutcomeError, never> {
    switch (terminal.outcome) {
      case "succeeded":
        return Effect.succeed(terminal.result as R);
      case "replaced":
        return Effect.succeed(terminal.result as R);
      case "failed":
        return Effect.fail(new OperationOutcomeError("failed", terminal));
      case "canceled":
        return Effect.fail(new OperationOutcomeError("canceled", terminal));
      case "vetoed":
        return Effect.fail(new OperationOutcomeError("vetoed", terminal));
      case "deferred":
        return Effect.fail(new OperationOutcomeError("deferred", terminal));
    }
  }

  private normalizeError(err: unknown): ProtocolEvent["error"] {
    if (err && typeof err === "object" && "message" in err) {
      const e = err as { name?: string; message?: string };
      return {
        name: e.name ?? "Error",
        message: typeof e.message === "string" ? e.message : String(err),
        data: err,
      };
    }
    return { name: "Error", message: String(err), data: err };
  }

  /**
   * Publish to bus + (conditionally) journal per policy.
   *
   * Decision order:
   *   1. `policy.override[exactName]`  drop | bus-only | always
   *   2. `policy.override[prefix]`     longest-prefix match
   *   3. `policy.alwaysJournal` / `policy.busOnly` phase rules
   *   4. Default-deny on unknown phases
   */
  private publish(envelope: ProtocolEvent): Effect.Effect<void, JournalError, never> {
    const decision = this.decide(envelope);
    if (decision === "drop") return Effect.void;
    if (decision === "always" || decision === "journal") {
      return Effect.zipRight(this.bus.publish(envelope), this.journal.append(envelope));
    }
    return this.bus.publish(envelope);
  }

  private decide(envelope: ProtocolEvent): "always" | "journal" | "bus-only" | "drop" {
    return this.decideFromShape(envelope.name, envelope.phase);
  }

  /**
   * Policy routing keyed by the cheapest-to-compute envelope subset
   * (name + phase). Lets `emitLazy` / `emitDeltaLazy` decide whether
   * to construct the envelope at all before paying ULID + timestamp +
   * payload cost.
   */
  private decideFromShape(
    name: string,
    phase: EventPhase,
  ): "always" | "journal" | "bus-only" | "drop" {
    const override = this.policy.override ? matchOverride(name, this.policy.override) : undefined;
    if (override === "drop") return "drop";
    if (override === "always") return "always";
    if (override === "bus-only") return "bus-only";
    if (this.policy.alwaysJournal.includes(phase)) return "journal";
    if (this.policy.busOnly.includes(phase)) return "bus-only";
    return "bus-only";
  }
}

function matchOverride(
  name: string,
  table: Readonly<Record<string, "always" | "bus-only" | "drop">>,
): "always" | "bus-only" | "drop" | undefined {
  if (name in table) return table[name];
  let best: { key: string; value: "always" | "bus-only" | "drop" } | undefined;
  for (const [key, value] of Object.entries(table)) {
    if (name.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, value };
    }
  }
  return best?.value;
}

/**
 * Surfaced through the `runOperation` failure channel when an operation
 * terminates with a non-success outcome (failed, canceled, vetoed,
 * deferred). The `terminal` field exposes the typed envelope.
 *
 * On the `failed` path, the substrate publishes the terminal:failed
 * envelope BUT re-raises the body's original typed error rather than
 * wrapping in `OperationOutcomeError`. Veto / canceled / deferred / the
 * replay path for cached failed terminals use this error class so the
 * caller can pattern-match.
 */
export class OperationOutcomeError extends Error {
  readonly _tag = "OperationOutcomeError" as const;
  readonly outcome: CommandOutcome;
  readonly terminal: TerminalEvent;
  constructor(outcome: CommandOutcome, terminal: TerminalEvent) {
    super(`operation outcome: ${outcome}`);
    this.name = "OperationOutcomeError";
    this.outcome = outcome;
    this.terminal = terminal;
  }
}

// Re-export InboxError type so concrete harnesses can type-narrow
// without pulling from @agentick/spec directly.
export type { InboxError };

/**
 * Bridge an `Effect` running through `BaseHarness.runOperation` (or any
 * other Effect-typed harness machinery) to a Promise that rejects with
 * the original typed error instead of Effect's `FiberFailure` wrapper.
 *
 * Concrete harness protocol surfaces (e.g. `ReconcilerProtocol`,
 * `ToolExecutorProtocol`) keep Promise-typed return shapes for
 * ergonomic application code. This helper closes the gap: the typed
 * `SubstrateError` / `OperationOutcomeError` / body-`E` value at the
 * head of the failure cause becomes the Promise's rejection reason.
 *
 * Defects (interrupts, unhandled throws) reject with a normal `Error`
 * carrying `Cause.pretty(cause)`.
 */
export async function runHarnessProtocol<R>(eff: Effect.Effect<R, unknown, never>): Promise<R> {
  const exit = await Effect.runPromiseExit(eff);
  if (Exit.isSuccess(exit)) return exit.value as R;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw new Error(Cause.pretty(exit.cause));
}
