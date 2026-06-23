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
  EventBusFactory,
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
  MessageInboxFactory,
  Operation,
  OperationJournal,
  OperationJournalFactory,
  ProtocolEvent,
  SubstrateError,
  TerminalEvent,
  Unsubscribe,
} from "@agentick/spec-next";
import { DEFAULT_JOURNALING_POLICY } from "@agentick/spec-next";
import { resolveSyncSubstrateSlot } from "./resolve-slot.js";
import { ulid } from "./ulid.js";
import { EMPTY_CONTEXT, getContext, type RuntimeContext, withContext } from "./runtime-context.js";

/**
 * Sync snapshot of `RuntimeContextRef` for harness-construction-time
 * capture. Returns the EMPTY context when called outside any active
 * Effect fiber (top-of-tree adopter construction). Inside a fiber
 * that has the ref set (a `runOperation` body), returns that value.
 *
 * Implementation uses `Effect.runSync(getContext)`. Effect's `runSync`
 * of a pure FiberRef read is safe — no async, no scope acquisition.
 */
function readContextSnapshot(): RuntimeContext {
  try {
    return Effect.runSync(getContext);
  } catch {
    // Should never happen for a pure FiberRef.get — but if Effect's
    // runSync changes semantics in a future release, degrade gracefully
    // to the empty context.
    return EMPTY_CONTEXT;
  }
}
import { RequestResponseRegistry, type RequestError } from "./request-response-registry.js";

export type { Unsubscribe } from "@agentick/spec-next";

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

/**
 * Forward-reference shell that BaseHarness hands to substrate
 * factories during its own construction. Exposes the harness's
 * identity, adopter metadata, the substrate DEFAULTS (positional
 * args to the constructor — i.e. parent-provided substrate), and
 * a buffered `onClose` registration that's replayed onto the real
 * harness once construction completes.
 *
 * The same shape every level of the hierarchy sees. Future Gateway
 * and any other container harness inherit this for free.
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md §Two-phase construction
 */
export interface HarnessShell {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Substrate defaults (positional ctor args) — the parent's substrate. */
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
  readonly journal: OperationJournal;
  onClose(handler: () => void | Promise<void>): void;
}

export interface BaseHarnessOptions<P = unknown, I = unknown> {
  readonly policy?: JournalingPolicy;
  /**
   * Auto-register on the inbox at construction. Set false for harnesses
   * that handle their own registration timing. Default: true.
   */
  readonly autoRegisterInbox?: boolean;
  /**
   * Parent harness reference. Set by the framework when this harness
   * is constructed as a child of another (e.g. an AppHarness child
   * within a Gateway, a SessionHarness child within an App). Top-of-tree
   * harnesses have `parent === undefined`.
   *
   * Factories at slots inside this harness receive `this` as their
   * own `parent` argument; chain via `parent.parent` for grandparent
   * access. Typed when known by the harness subclass.
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  readonly parent?: P;
  /**
   * Construction input as supplied by the caller (or its merged form
   * after framework defaults). Stored on the harness for factories
   * inside it to read via `parent.input`. Subclasses narrow the type.
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  readonly input?: I;
  /**
   * Adopter-defined metadata bag. Framework defines no keys; adopters
   * stash whatever they want (tenant id, trace id, request shape,
   * routing hints). Factories inside this harness read via
   * `parent.metadata`.
   *
   * Carried through to the harness instance and exposed as
   * `harness.metadata`. Immutable post-construction.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Substrate slot overrides — `instance | factory`. When omitted,
   * the harness uses the positional substrate constructor args as-is
   * (the parent-provided defaults, today's behavior preserved).
   *
   * Factory form: `(parent: HarnessShell) => R`. The shell exposes
   * the positional substrate args as `.bus / .inbox / .journal`, so
   * factories that wrap their parent's substrate (e.g.
   * `LocalEventBus.factory()` defaults to fan-in via parent.bus)
   * compose naturally. `parent.onClose(h)` registers cleanup that
   * fires when THIS harness closes.
   *
   * This is the same `instance | factory` shape every level of the
   * hierarchy sees — Gateway → App → Session → (future). Implemented
   * once on BaseHarness; inherited by every subclass.
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  readonly bus?: EventBus | EventBusFactory<HarnessShell>;
  readonly inbox?: MessageInbox | MessageInboxFactory<HarnessShell>;
  readonly journal?: OperationJournal | OperationJournalFactory<HarnessShell>;
}

export abstract class BaseHarness<
  Surface extends EventSurface = EventSurface,
  Parent = unknown,
  Input = unknown,
> {
  /**
   * Cluster-portable inbox address — `${surface}:${scopeId}`. Public
   * so other harnesses can send `inbox.send(address, ...)` messages
   * without indirection through protocol-specific accessors.
   * Cluster-aware inboxes route to whichever node owns the address.
   */
  public readonly address: string;
  protected readonly handlers = new HandlerRegistry();
  protected readonly middleware = new MiddlewareChain();

  /**
   * Parent harness reference, if any. Top-of-tree harnesses have
   * `parent === undefined`. Set from `BaseHarnessOptions.parent` at
   * construction.
   */
  readonly parent: Parent | undefined;
  /**
   * Construction input as supplied by the caller. Set from
   * `BaseHarnessOptions.input` at construction. Factories inside this
   * harness read via `parent.input`.
   */
  readonly input: Input | undefined;
  /**
   * Adopter-defined metadata bag. Carried in from
   * `BaseHarnessOptions.metadata`. Frozen at construction so
   * downstream readers can rely on stability.
   */
  readonly metadata: Readonly<Record<string, unknown>>;

  /**
   * Snapshot of the {@link RuntimeContext} captured at construction.
   * Returned by {@link runtimeContext}; reflects the context of the
   * parent operation that triggered this harness's construction.
   */
  private readonly capturedContext: RuntimeContext;
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

  /**
   * Substrate used by this harness. Set from positional defaults
   * (the parent's substrate, passed in as ctor args) unless an
   * override is supplied in `options.{bus,inbox,journal}`.
   */
  protected readonly journal: OperationJournal;
  protected readonly bus: EventBus;
  protected readonly inbox: MessageInbox;

  constructor(
    protected readonly surface: Surface,
    protected readonly scopeId: string,
    defaultJournal: OperationJournal,
    defaultBus: EventBus,
    defaultInbox: MessageInbox,
    options: BaseHarnessOptions<Parent, Input> = {},
  ) {
    this.address = `${surface}:${scopeId}`;
    this.policy = options.policy ?? DEFAULT_JOURNALING_POLICY;
    this.parent = options.parent;
    this.input = options.input;
    this.metadata = Object.freeze({ ...(options.metadata ?? {}) });

    // Substrate slot resolution (ADR 31). Build a shell exposing the
    // positional substrate defaults as the parent-side upstream, then
    // resolve each slot. Factories see `parent.bus / .inbox / .journal`
    // = the defaults, and register `onClose(h)` against a buffer that
    // replays onto `this.onClose` once the harness's own state is set
    // up. Subclasses that don't supply substrate options get
    // today's behavior (use the positional defaults as-is).
    const pendingCloseHandlers: Array<() => void | Promise<void>> = [];
    const shell: HarnessShell = {
      id: scopeId,
      metadata: this.metadata,
      bus: defaultBus,
      inbox: defaultInbox,
      journal: defaultJournal,
      onClose: (h) => pendingCloseHandlers.push(h),
    };
    this.journal = resolveSyncSubstrateSlot<
      OperationJournal,
      HarnessShell,
      OperationJournalFactory<HarnessShell>
    >(options.journal, shell, () => defaultJournal, `${surface}.journal`);
    this.bus = resolveSyncSubstrateSlot<EventBus, HarnessShell, EventBusFactory<HarnessShell>>(
      options.bus,
      shell,
      () => defaultBus,
      `${surface}.bus`,
    );
    this.inbox = resolveSyncSubstrateSlot<
      MessageInbox,
      HarnessShell,
      MessageInboxFactory<HarnessShell>
    >(options.inbox, shell, () => defaultInbox, `${surface}.inbox`);
    // Replay buffered close handlers onto this (the now-real harness).
    for (const h of pendingCloseHandlers) this.onClose(h);

    // Snapshot the current operation's RuntimeContext at construction.
    // Empty when constructed outside any active Operation (the common
    // case for top-of-tree harnesses constructed by adopter code).
    this.capturedContext = readContextSnapshot();
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

  /**
   * Sync read of the {@link RuntimeContext} captured at this harness's
   * construction time. Reflects the context of the parent Operation
   * that triggered construction (sessionId, executionId, tickId, opId,
   * parentOpId, correlationId — whatever was set on the parent's
   * fiber when this harness's substrate/slot factories ran).
   *
   * Returns an empty context when this harness was constructed outside
   * any active Operation (the common case for top-of-tree adopter
   * code).
   *
   * Adopters writing substrate or slot factories use
   * `parent.runtimeContext()` to read this without going Effect-native.
   * Effect-typed factories may also yield `getContext` for the same
   * info from inside `Effect.gen`.
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  runtimeContext(): RuntimeContext {
    return this.capturedContext;
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
   * `bus.hasSubscriberFor` is false.
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
    if (!this.bus.hasSubscriberFor({ surface: this.surface, name: key.name, phase: key.phase })) {
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
      !this.bus.hasSubscriberFor({
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
   *
   * **Resolution order** when an inbox message arrives:
   *   1. `request-response` → auto-intercepted by `dispatchMessage`,
   *      routed to the request/response registry. Subclasses never see
   *      these.
   *   2. A handler registered via {@link onMessage} for `msg.type` →
   *      runs *instead of* the subclass's `handleMessage` for that
   *      type. Lets adopters override built-in message handling per
   *      type without subclassing.
   *   3. Otherwise → falls through to `handleMessage` for the typed
   *      switch the subclass owns.
   */
  protected abstract handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never>;

  /**
   * Custom inbox-message handlers registered via {@link onMessage}.
   * Single handler per type — last registration wins; on `Unsubscribe`
   * the previously-active handler (if any) is restored. Empty by
   * default; `dispatchMessage` consults this map after the
   * `request-response` auto-intercept and before falling through to
   * `handleMessage`.
   */
  private readonly customMessageHandlers = new Map<
    string,
    (msg: MessageEnvelope) => Effect.Effect<unknown, MessageHandlerError, never>
  >();

  /**
   * Register a handler for a custom inbox message type — the
   * adopter-facing extension point for "add a handler for a new
   * message kind" and "override built-in handling for an existing
   * one."
   *
   *   - Single handler per `type`. Re-registering replaces the
   *     previous handler; the returned `Unsubscribe` restores it (or
   *     removes the entry entirely if there was no prior handler).
   *   - Routed BEFORE the subclass's `handleMessage` switch — a
   *     handler registered for a protocol-defined type (e.g.,
   *     `"knobs:set"`) silently overrides the built-in dispatch for
   *     that type as long as it's installed.
   *   - Errors propagate as {@link MessageHandlerError} the same way
   *     `handleMessage` returns do. `dispatchMessage` wraps non-tagged
   *     throws via `Effect.catchAll`.
   *
   * Why not `harness.inbox.register(...)`? — `inbox.register` is a
   * substrate primitive: one handler per address. The harness already
   * owns its address's handler (the one routing through
   * `dispatchMessage` so `request-response` auto-intercept,
   * middleware, lifecycle, journaling all participate). Re-registering
   * at the same address would clobber that. `onMessage` adds typed
   * dispatch INSIDE that single inbox subscription, preserving every
   * harness facility.
   */
  onMessage<P = unknown>(
    type: string,
    handler: (msg: MessageEnvelope<P>) => Effect.Effect<unknown, MessageHandlerError, never>,
  ): Unsubscribe {
    const prev = this.customMessageHandlers.get(type);
    const erased = handler as (
      msg: MessageEnvelope,
    ) => Effect.Effect<unknown, MessageHandlerError, never>;
    this.customMessageHandlers.set(type, erased);
    return () => {
      if (this.customMessageHandlers.get(type) !== erased) return;
      if (prev !== undefined) this.customMessageHandlers.set(type, prev);
      else this.customMessageHandlers.delete(type);
    };
  }

  private dispatchMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    // Auto-intercept `request-response` messages BEFORE anything else.
    // The payload's `correlationId` routes to the pending Deferred via
    // the registry. Custom handlers + subclasses never see these.
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
    // Custom handlers (onMessage) take precedence over the subclass's
    // built-in switch — that's how "override built-in handling" works.
    const custom = this.customMessageHandlers.get(msg.type);
    if (custom !== undefined) {
      return custom(msg).pipe(
        Effect.catchAll((cause) =>
          Effect.fail<MessageHandlerError>({ _tag: "HandlerError", cause }),
        ),
      );
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
    opts: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
      /**
       * Scope stamped on the published envelope. Session-scoped
       * subscriptions filter on `scope.sessionId` — harnesses that
       * publish from within a session MUST pass `{ sessionId }` so
       * the gateway can route the envelope to the right subscribers.
       * Defaults to the harness's captured RuntimeContext scope.
       */
      readonly scope?: EventScope;
    } = {},
  ): Effect.Effect<TResp, RequestError, never> {
    const correlationId = `req:${ulid()}`;
    const replyTo = this.address;
    const registered = this.requests.register({
      correlationId,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    // Resolve scope precedence: explicit > captured-at-construction.
    // The captured context carries any RuntimeContext fields the
    // parent operation set when this harness was constructed; the
    // explicit override lets per-call code stamp a different scope
    // (e.g., the elicitation harness stamping its parent sessionId).
    const ctxScope: EventScope = {
      ...(this.capturedContext.sessionId !== undefined
        ? { sessionId: this.capturedContext.sessionId }
        : {}),
      ...(this.capturedContext.executionId !== undefined
        ? { executionId: this.capturedContext.executionId }
        : {}),
      ...(this.capturedContext.tickId !== undefined ? { tickId: this.capturedContext.tickId } : {}),
    };
    const scope: EventScope = opts.scope ?? ctxScope;
    // Publish the request envelope on the bus. The channel name pattern
    // matches `ChannelHandle.publish` — `session:channel:<channel>`.
    const fullName = `session:channel:${channel}`;
    const envelope: ProtocolEvent = {
      id: ulid(),
      surface: "session",
      name: fullName,
      phase: "delta",
      timestamp: Date.now(),
      scope,
      payload,
      metadata: {
        requestType: "request",
        correlationId,
        replyTo,
      },
    } as ProtocolEvent;
    return Effect.flatMap(this.bus.append(envelope), () =>
      Effect.tryPromise<TResp, RequestError>({
        try: () => registered.promise as Promise<TResp>,
        catch: (cause): RequestError => cause as RequestError,
      }),
    );
  }

  // ──────── lifecycle ────────

  /**
   * Close handlers registered via {@link onClose}. Fired in LIFO order
   * during {@link close}; each handler is `await`ed; throws are
   * caught + logged so one failure doesn't block subsequent cleanups.
   */
  private readonly closeHandlers: Array<() => void | Promise<void>> = [];

  /**
   * Register a teardown that runs at this harness's close. Fires LIFO
   * against registration. Throws are error-isolated — one failure
   * does not block subsequent cleanups.
   *
   * Factories at slots inside this harness use `parent.onClose(h)` to
   * register cleanup that fires when the parent closes. The framework
   * uses this to cascade substrate-close down the hierarchy: when an
   * AppHarness closes, every factory-registered handler (close the
   * bus, close the inbox, close the journal, …) fires.
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  onClose(handler: () => void | Promise<void>): void {
    this.closeHandlers.push(handler);
  }

  /**
   * Detach this harness from the inbox and fire all registered
   * `onClose` handlers in LIFO order with error isolation.
   *
   * **Subclasses that wrap close in a runOperation** (e.g.
   * `AppHarness.closeApp`) MUST mark their close-Op name as
   * `"bus-only"` in their {@link JournalingPolicy} `override` map.
   * Otherwise the framework appends a terminal envelope to a journal
   * that an `onClose` handler may have closed during the body.
   * See `AppHarness` constructor for the canonical pattern.
   */
  async close(): Promise<void> {
    if (this.inboxUnsubscribe) {
      this.inboxUnsubscribe();
      this.inboxUnsubscribe = undefined;
    }
    // LIFO unwind. Each handler is awaited so async cleanup completes
    // before the next runs. Errors logged but never propagated — one
    // bad handler must not block the rest.
    while (this.closeHandlers.length > 0) {
      const h = this.closeHandlers.pop()!;
      try {
        await h();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("BaseHarness onClose handler failed:", err);
      }
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
      parentOpId: op.parentOpId,
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
      return Effect.zipRight(this.bus.append(envelope), this.journal.append(envelope));
    }
    return this.bus.append(envelope);
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
// without pulling from @agentick/spec-next directly.
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
