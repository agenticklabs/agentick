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

import { Cause, Effect, Exit, Fiber, FiberRef, ManagedRuntime, Option, Queue } from "effect";
import { unwrapExit, omitUndefined, isThenable } from "@agentick/utils-next";
import type {
  AsyncStream,
  CommandOutcome,
  EventBus,
  CommandDescriptor,
  CommandExposure,
  CommandInfo,
  EventBusFactory,
  EventPhase,
  EventScope,
  EventSurface,
  HandlerVerdict,
  HarnessFx,
  InboxError,
  JournalError,
  JournalingPolicy,
  LogLevel,
  Middleware,
  ProgressEventPayload,
  MessageEnvelope,
  MessageInbox,
  MessageInboxFactory,
  Operation,
  OperationJournal,
  OperationJournalFactory,
  OperationOrigin,
  ProtocolEvent,
  StandardSchemaV1,
  SubstrateError,
  TerminalEvent,
  Unsubscribe,
} from "@agentick/spec-next";
import {
  AgentickError,
  CommandDeclarationError,
  DEFAULT_JOURNALING_POLICY,
  logEventName,
  progressEventName,
  HandlerError,
  InvalidPayload,
  LifecycleHandlerError,
  MessageHandlerError,
  registerAgentickError,
} from "@agentick/spec-next";
import { resolveSyncSubstrateSlot } from "./resolve-slot.js";
import { ulid } from "./ulid.js";
import { getContext, type RuntimeContext, withContext } from "./runtime-context.js";
import { RequestResponseRegistry, type RequestError } from "./request-response-registry.js";

export type { Unsubscribe } from "@agentick/spec-next";

/**
 * A declared command in a harness's registry (ADR 51): the wire-safe
 * descriptor plus the bound runner that manufactures the Operation and
 * routes it through `runOperation`.
 */
interface RegisteredCommand {
  readonly descriptor: CommandDescriptor;
  readonly run: (
    input: unknown,
    opts: {
      readonly origin: OperationOrigin;
      readonly parentOpId?: string;
      readonly correlationId?: string;
    },
  ) => Effect.Effect<unknown, unknown, never>;
}

/**
 * Lifecycle handler. Runs at a phase boundary (typically `before`); may
 * return a {@link HandlerVerdict} to influence command execution.
 *
 * Returning `void` is equivalent to `{ kind: "proceed" }`.
 */
export type LifecycleHandler<I = unknown, R = unknown, E = never> = (
  input: I,
) => Effect.Effect<HandlerVerdict<R> | void, E, never>;

// `Middleware` (Effect-native, `fx.use`) + `HarnessFx` are defined in
// `@agentick/spec-next` (so the `XFx` protocols can type `fx.use`) and
// re-exported here. `AsyncMiddleware` (pure-JS, `use`) is defined below —
// it carries `RuntimeContext`, a runtime concern.
export type { Middleware, HarnessFx } from "@agentick/spec-next";

/**
 * Pure-JS middleware — the ergonomic `harness.use` form. `next(input)` returns
 * a Promise; `await` it to proceed, or return a value to short-circuit. No
 * Effect knowledge required.
 *
 * The third argument, **`ctx`**, is the operation's {@link RuntimeContext}
 * (sessionId / executionId / tickId / opId / parentOpId / user …), passed
 * EXPLICITLY: an async middleware runs OUTSIDE the fiber (see the caveat
 * below), so it cannot read `getContext` itself — `use`'s lift hands it the
 * snapshot captured at the op boundary. An Effect middleware (`fx.use`) reads
 * the same context natively via `yield* getContext`.
 *
 * ```ts
 * harness.use(async (input, next, ctx) => {
 *   const started = Date.now();
 *   const result = await next(input);
 *   metrics.record(ctx.sessionId, ctx.opId, Date.now() - started);
 *   return result;
 * });
 * ```
 *
 * **Honest caveat — the fiber severs here.** `await next(input)` runs the inner
 * operations to a Promise (a fresh root fiber), so the ADR 77 spine's in-fiber
 * propagation stops AT an async middleware: OTel span-parent nesting and
 * structured interruption do NOT cross it. The lift re-threads `ctx` onto the
 * continuation so `parentOpId` (the causal tree) survives and traces stay
 * reconstructable from attributes — but that is the limit. For middleware that
 * must stay in-fiber, use `harness.fx.use` (the Effect-native {@link Middleware}).
 * Async = ergonomic; Effect = in-fiber.
 */
export type AsyncMiddleware<I = unknown, R = unknown> = (
  input: I,
  next: (input: I) => Promise<R>,
  ctx: RuntimeContext,
) => Promise<R>;

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

/**
 * Compose an explicit middleware list around a body. First element is
 * outermost. Shared by {@link MiddlewareChain.compose} and (ADR 76)
 * by `BaseHarness.runOperation` when it composes an inherited stack
 * collected across construction-ancestors.
 */
export function composeMiddleware<I, R, E>(
  list: readonly Middleware<I, R, E>[],
  body: (input: I) => Effect.Effect<R, E, never>,
): (input: I) => Effect.Effect<R, E, never> {
  return list.reduceRight<(input: I) => Effect.Effect<R, E, never>>(
    (next, mw) => (input) => mw(input, next),
    body,
  );
}

/**
 * Lift an {@link AsyncMiddleware} (pure JS) into the Effect-native
 * {@link Middleware} the chain composes. The lifted middleware runs the inner
 * `next` as a `Promise` (`Effect.runPromise`) so the adopter can `await` it —
 * a fresh root fiber, so the spine's in-fiber propagation SEVERS here (see the
 * caveat on {@link AsyncMiddleware}). The ambient `RuntimeContext` is captured
 * and re-applied across that boundary, so `parentOpId` (the causal tree)
 * survives even though the fiber does not. A rejection (from `next`, or thrown
 * by the async middleware) surfaces on the `E` channel unchanged.
 *
 * `use()` / `withCallMiddleware` call this automatically for `async` functions;
 * use it explicitly for a promise-returning middleware NOT declared `async`.
 */
export function liftMiddleware<I = unknown, R = unknown, E = unknown>(
  mw: AsyncMiddleware<I, R>,
): Middleware<I, R, E> {
  return (input, next) =>
    Effect.gen(function* () {
      // Snapshot the ambient context so the causal tree survives the Promise
      // boundary (the fresh root fiber below would otherwise see EMPTY_CONTEXT).
      const ctx = yield* getContext;
      const nextPromise = (i: I): Promise<R> =>
        Effect.runPromise(withContext(ctx, next(i)) as Effect.Effect<R, never, never>);
      // Hand the async middleware the captured `ctx` explicitly — it runs
      // outside the fiber and can't read `getContext` itself.
      return yield* Effect.tryPromise({
        try: () => mw(input, nextPromise, ctx),
        catch: (e) => e as E,
      });
    });
}

// ============================================================================
// Tier 4 — call-scoped (dynamic) middleware (ADR 76)
// ============================================================================

/**
 * FiberRef carrying the CALL-SCOPED (tier-4) operation middleware — the
 * broadest scope, composed outermost of all. Distinct from the
 * construction-tree scopes (tier 2 `harness.use()` / tier 3 structural
 * inheritance): tier 4 is scoped to a *dynamic call tree*, not the
 * construction tree.
 *
 * **Enabled by the ADR 77 spine.** Before the spine, the operation tree was
 * ~40 independent `runPromise` roots, so a FiberRef could not propagate a
 * middleware list across harness boundaries — tier 4 was impossible. Now the
 * call `session.send → loop → executor → tool` is ONE fiber, so this
 * FiberRef reaches every nested `runOperation` in every harness the call
 * touches — *even across construction-siblings* (the app builds the loop /
 * executor / tool as shared singletons; they are not construction-children
 * of the session, so a session-scoped concern around the model call CANNOT
 * be expressed structurally — only here, dynamically).
 */
const CallMiddlewareRef = FiberRef.unsafeMake<readonly Middleware<unknown, unknown, unknown>[]>([]);

/** Read the ambient call-scoped middleware list. Substrate-internal. */
const getCallMiddleware: Effect.Effect<readonly Middleware<unknown, unknown, unknown>[]> =
  FiberRef.get(CallMiddlewareRef);

/**
 * Scope `middleware` around `effect` for the current dynamic call tree
 * (ADR 76 tier 4). Every nested `runOperation` the effect transitively
 * reaches — in ANY harness, across construction-siblings — composes it
 * **outermost** (broadest scope); when `effect` settles it evaporates.
 * Nested `withCallMiddleware` calls ACCUMULATE (append, so an outer
 * provider stays outermost). Empty list is a pass-through.
 *
 * The Effect-native tier-4 surface (in-fiber): `withCallMiddleware([cap],
 * someEffect)` — e.g., a per-`send` budget cap or a per-request trace attribute
 * that must wrap every op the request touches, then vanish. Takes the
 * Effect-native {@link Middleware}; for a pure-JS async tier-4 middleware wrap
 * it with {@link liftMiddleware}.
 */
export function withCallMiddleware<A, E, R>(
  middleware: readonly Middleware<unknown, unknown, unknown>[],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  if (middleware.length === 0) return effect;
  return Effect.flatMap(getCallMiddleware, (current) =>
    Effect.locally(CallMiddlewareRef, [...current, ...middleware])(effect),
  );
}

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
   * Snapshot the registered middleware in registration order (first =
   * outermost). ADR 76: used to collect an inherited stack across
   * construction-ancestors without mutating any chain.
   */
  snapshot(): Middleware<unknown, unknown, unknown>[] {
    return this.middlewares.slice();
  }

  /**
   * Compose middlewares around a body. The first registered is outermost.
   */
  compose<I, R, E>(
    body: (input: I) => Effect.Effect<R, E, never>,
  ): (input: I) => Effect.Effect<R, E, never> {
    return composeMiddleware(this.middlewares.slice() as Middleware<I, R, E>[], body);
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
   * Principal scope key — the identity axis of the harness's
   * construction identity (ADR 48), the twin of `scopeId` (the work
   * axis). An opaque, hierarchical-by-convention key (e.g.
   * `"acme/user-42"`) identifying WHOSE behalf this harness acts on.
   *
   * Bound at construction (structural identity, ADR 45), never read
   * ambiently. Harnesses that scope by identity (credentials, tasks,
   * sandbox, MCP connections) read `this.principal` to namespace their
   * backing stores; harnesses that don't simply ignore it.
   *
   * `undefined` for principal-less deployments (a local single-user
   * agent, a stdio MCP connection). The one identity dimension
   * BaseHarness can stamp uniformly — unlike `scopeId`, whose scope
   * field is surface-specific — so it is centralized here to prevent
   * per-command drift. See {@link BaseHarness.makeEvent}.
   */
  readonly principal?: string;
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
  /**
   * Span-attribute namespace (ADR 78) — the prefix on every telemetry
   * attribute key. Defaults to `"agentick"`; whitelabel deployments override
   * it. Threaded from the app so a deployment sets it once.
   */
  readonly telemetryNamespace?: string;
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
   * Principal scope key — the identity axis of construction identity
   * (ADR 48), fixed at construction. `undefined` for principal-less
   * harnesses. Read by identity-scoping harnesses to namespace their
   * stores; stamped authoritatively onto emitted event scopes by
   * {@link makeEvent} (an operation cannot override it — no per-op
   * identity spoofing).
   */
  /**
   * Construction-bound owning principal (ADR 48) — PUBLIC structural
   * identity: the wire dispatch gate reads the TARGET harness's
   * principal for the same-principal rule (ADR 51 §4.2). Identity is a
   * fact, not policy; policy stays in the Authorizer.
   */
  readonly principal: string | undefined;

  /**
   * In-flight request/response correlation map. Every BaseHarness can
   * issue `this.request(channel, payload)` and receives `request-response`
   * inbox messages routed automatically by `dispatchMessage` before
   * the subclass's `handleMessage` is consulted.
   */
  protected readonly requests = new RequestResponseRegistry<unknown>();

  /**
   * Span-attribute namespace (ADR 78). The prefix on every `spanAttributes`
   * key (`<ns>.op_id`, `<ns>.surface`, …). Defaults to `"agentick"`;
   * whitelabel deployments override it once (`agentick.config` / app option),
   * so their traces read `acme.op_id` rather than leaking the framework name.
   * Capability + overridable default — never a hardcode.
   */
  protected readonly telemetryNamespace: string;
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
   * Register a PURE-JS async middleware (tier 2) around this harness's ops —
   * the ergonomic default surface (dual of `harness.fx.use`, which takes the
   * Effect-native {@link Middleware}). `next(input)` returns a Promise; `await`
   * it. No Effect knowledge required. Single-typed, so an inline arrow infers:
   *
   * ```ts
   * harness.use(async (input, next) => {
   *   const start = Date.now();
   *   const result = await next(input);
   *   record(Date.now() - start);
   *   return result;
   * });
   * ```
   *
   * Lifted to an Effect middleware internally ({@link liftMiddleware}); the
   * chain only ever holds Effect middleware. An async middleware SEVERS the
   * fiber — use `harness.fx.use` for middleware that must stay in-fiber (see
   * the caveat on {@link AsyncMiddleware}).
   *
   * Note: this is the universal surface. Harnesses whose *public* commands
   * don't currently go through `runOperation` (`SessionHarness.send`,
   * `AppHarness.createSession`) accept registrations but those operations
   * aren't wrapped until refactored onto `runOperation`.
   */
  use<I = unknown, R = unknown>(mw: AsyncMiddleware<I, R>): Unsubscribe {
    return this.middleware.use(liftMiddleware(mw) as Middleware<unknown, unknown, unknown>);
  }

  /**
   * The harness's `.fx` surface — the Effect-native operations twin PLUS
   * `fx.use` (register an Effect-native {@link Middleware}, in-fiber). Concrete
   * op-harnesses OVERRIDE this to add their operation twins (`fx.run`, …); this
   * base provides the middleware register for harnesses without op twins (app,
   * gateway) and is the type all `XFx` extend via {@link HarnessFx}.
   */
  get fx(): HarnessFx {
    return { use: (mw) => this.registerEffectMiddleware(mw) };
  }

  /**
   * Register an Effect-native {@link Middleware} on this harness's chain — the
   * impl behind `fx.use`. Exposed `protected` so each concrete `get fx()`
   * override can include `use: (mw) => this.registerEffectMiddleware(mw)`.
   */
  protected registerEffectMiddleware<I, R, E>(mw: Middleware<I, R, E>): Unsubscribe {
    return this.middleware.use(mw as Middleware<unknown, unknown, unknown>);
  }

  /**
   * ADR 76 — structural middleware inheritance (tier 3).
   *
   * Collect this harness's middleware plus every *construction*-ancestor's,
   * ordered **root-outermost**: the returned list is
   * `[...root.mw, …, ...parent.mw, ...this.mw]`. Recursion up the `parent`
   * pointer (ADR 31) terminates at the first non-`BaseHarness` parent
   * (top-of-tree). Collected **fresh per operation** so a late `use()` /
   * unsubscribe on an ancestor is honored.
   *
   * Behavior-preserving: a root harness returns exactly its own chain; a
   * child whose ancestors registered nothing returns exactly its own chain.
   * The inherited stack only does something once an ancestor is `.use()`d.
   *
   * TODO(perf): walks the ancestor chain each op. Depth is ≈3–4
   * (gateway→app→session→sub); memoize + invalidate-on-`use` only if a hot
   * path profiles badly. See ADR 76 open question Q1.
   */
  protected ownAndInheritedMiddleware(): Middleware<unknown, unknown, unknown>[] {
    // `parent` is typed `Parent | undefined`; narrow structurally. Protected
    // access across instances of the same class is permitted within the class.
    const inherited =
      this.parent instanceof BaseHarness ? this.parent.ownAndInheritedMiddleware() : [];
    // Ancestors are broader scope → outermost → first in the list.
    return [...inherited, ...this.middleware.snapshot()];
  }

  /**
   * ADR 76 Q2 — run the `before` verdict handlers of every
   * construction-ancestor (root-outermost) followed by this harness's own,
   * merging the verdicts (`veto > replace > defer > proceed`) and
   * short-circuiting on the first `veto`. Mirrors {@link ownAndInheritedMiddleware}
   * so the two intercept seams — freeform `Middleware` and the verdict
   * `HandlerRegistry` — share ONE scoping model (an adopter would be surprised
   * if `app.use()` reached a descendant but an app-level `before` handler did
   * not). Walked fresh per op. Behavior-preserving: a root harness, or one whose
   * ancestors registered no `before` handlers, runs exactly its own chain.
   */
  protected runInheritedBefore<I, R>(input: I): Effect.Effect<HandlerVerdict<R>, unknown, never> {
    const self = this;
    return Effect.gen(function* () {
      let merged: HandlerVerdict<R> = { kind: "proceed" };
      if (self.parent instanceof BaseHarness) {
        merged = yield* self.parent.runInheritedBefore<I, R>(input);
        if (merged.kind === "veto") return merged;
      }
      const own = yield* self.handlers.run<I, R>("before", input);
      return mergeVerdict(merged, own);
    });
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
    this.principal = options.principal;
    this.telemetryNamespace = options.telemetryNamespace ?? "agentick";

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

            // 2. Append `requested`. The blueprint's phase contract
            //    pins requested as "argument bound" — the envelope's
            //    payload IS the operation's input so any subscriber
            //    (eval ledgers, OTel exporters, replay harnesses) sees
            //    what was invoked without having to reach into the
            //    operation by opId.
            yield* this.publish(
              this.makeEvent(resolvedOp, "requested", scope, { payload: resolvedOp.input }),
            );

            // 3. Append `before` and run handlers — this harness's PLUS
            // every construction-ancestor's, root-outermost (ADR 76 Q2:
            // handler inheritance mirrors tier-3 middleware inheritance, so
            // `app.on*()` reaches a descendant op the same way `app.use()`
            // does; the scoping model is uniform across both intercept seams).
            yield* this.publish(this.makeEvent(resolvedOp, "before", scope));
            const verdictExit = yield* Effect.exit(this.runInheritedBefore<I, R>(resolvedOp.input));
            if (Exit.isFailure(verdictExit)) {
              const cause = Cause.failureOption(verdictExit.cause);
              const lifecycleErr = new LifecycleHandlerError({
                phase: "before",
                cause: Option.isSome(cause) ? cause.value : verdictExit.cause,
              });
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
            // ADR 76 composition order (outermost → innermost):
            //   call-scoped (tier 4, FiberRef — broadest)
            //     → inherited ancestors (tier 3, root → parent)
            //       → this harness (tier 2)
            //         → body
            // Tier 4 is read from the FiberRef the ADR 77 spine made
            // continuous across harness boundaries; tiers 2/3 walk the
            // construction tree. Both reduce to a pass-through when nothing
            // is registered (behavior-preserving).
            const callMiddleware = yield* getCallMiddleware;
            const composed = composeMiddleware<I, R, E>(
              [...callMiddleware, ...this.ownAndInheritedMiddleware()] as Middleware<I, R, E>[],
              body,
            );
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
    const ns = this.telemetryNamespace;
    return {
      [`${ns}.op_id`]: op.opId,
      [`${ns}.surface`]: op.surface,
      [`${ns}.parent_op_id`]: op.parentOpId,
      [`${ns}.correlation_id`]: op.correlationId,
      [`${ns}.session_id`]: scope.sessionId,
      [`${ns}.execution_id`]: scope.executionId,
      [`${ns}.tick_id`]: scope.tickId,
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

  // ──────── ⑤b Signals (log + progress) — ADR 64 ────────

  // TODO(#19-ambient): there is intentionally NO ambient global
  // `Context.log` / `Context.progress` (a FiberRef-resolved emitter any
  // code could call). Non-tool components that log ARE harnesses (the
  // loop, the session) → they emit via `emitLog` / `emitProgress`
  // directly. A FiberRef-ambient global would be a second entry point
  // with known Promise-bridge propagation hazards (the emit fiber loses
  // the ambient scope across `await`). Revisit only if a concrete
  // non-harness caller appears; until then the two protected helpers are
  // the sole seam.

  /**
   * Emit a `log` signal — a structured out-of-band diagnostic (ADR 64).
   * The canonical entry point behind `ctx.log`; non-tool components (the
   * loop, session, any harness) call this directly.
   *
   * Name is `<surface>:signal:log`; phase is `"terminal"` (a discrete
   * notification, no opId); payload is a {@link LogEventPayload}.
   *
   * **Structurally bus-only.** Signals are ephemeral diagnostics — they
   * are NEVER journaled, regardless of the harness's
   * {@link JournalingPolicy}. This is why the helper bypasses `publish`
   * / `decideFromShape` (which would route `terminal` to the journal per
   * `DEFAULT_JOURNALING_POLICY.alwaysJournal`) and appends straight to
   * the bus. Routing signal spam into the recovery/audit spine would
   * bloat it for zero durability benefit. The subscriber-probe keeps the
   * no-listener cost to one map lookup (fire-and-forget parity with
   * `emitLazy`).
   *
   * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
   */
  protected emitLog(
    scope: EventScope,
    level: LogLevel,
    data: unknown,
    logger?: string,
  ): Effect.Effect<void, JournalError, never> {
    return this.emitSignal(
      logEventName(this.surface),
      scope,
      logger !== undefined ? { level, data, logger } : { level, data },
    );
  }

  /**
   * Emit a `progress` signal — out-of-band liveness for long-running
   * work (ADR 64). The canonical entry point behind `ctx.progress`.
   *
   * Name is `<surface>:signal:progress`; phase is `"terminal"`; payload
   * is a {@link ProgressEventPayload}. Structurally bus-only for the
   * same reason as {@link emitLog}.
   *
   * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
   */
  protected emitProgress(
    scope: EventScope,
    p: ProgressEventPayload,
  ): Effect.Effect<void, JournalError, never> {
    return this.emitSignal(progressEventName(this.surface), scope, p);
  }

  /**
   * Shared bus-only append for the signal family. Probes the subscriber
   * index first (no listener → one map lookup, no envelope), then
   * appends the discrete `terminal` envelope directly to the bus —
   * never the journal. Stamps the harness's construction-bound principal
   * like {@link makeEvent} does.
   */
  private emitSignal(
    name: string,
    scope: EventScope,
    payload: unknown,
  ): Effect.Effect<void, JournalError, never> {
    if (!this.bus.hasSubscriberFor({ surface: this.surface, name, phase: "terminal" })) {
      return Effect.void;
    }
    const envelope: ProtocolEvent = {
      id: ulid(),
      surface: this.surface,
      name,
      phase: "terminal",
      timestamp: Date.now(),
      scope:
        this.principal !== undefined
          ? omitUndefined({ ...scope, principal: this.principal })
          : scope,
      payload,
    } as ProtocolEvent;
    return this.bus.append(envelope);
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

  // ──────── command registry (ADR 51) ────────

  /**
   * Declared commands, keyed by canonical verb. Built dynamically by
   * {@link command} — the declaration IS the registration; no parallel
   * table to maintain. Consulted by {@link dispatchMessage} after
   * custom handlers, before the `handleMessage` fallthrough.
   */
  private readonly commandRegistry = new Map<string, RegisteredCommand>();

  /**
   * Declare a command — the single declaration site for a harness verb
   * (ADR 51 §2). The canonical `name` string is simultaneously the
   * inbox message type, the op-name root, the authz scope label, and
   * (via `:` → `/`) the wire method name.
   *
   * Returns the public method: it manufactures the same Operation the
   * hand-written pattern builds (`opId: \`${verb}:${ulid()}\``,
   * `name: \`${surface}:command:${rest}\``) and runs it through
   * {@link runOperation} unchanged — phase contract, journaling,
   * idempotency, middleware all apply.
   *
   * Declaring also makes the verb **inbox-addressable** (unless
   * `exposure: "internal"`): a message whose `type` matches the verb
   * is validated against `input` (once, here — the wire does not
   * duplicate validation), stamped with the delivering gate's
   * `origin` (default `"inbox"`), and invoked through the same path.
   * `ask` replies with the handler's result via the existing inbox
   * contract; `send` is fire-and-forget.
   *
   * The signal-form rule (ADR 51 §1.2): commands carry verbs +
   * serializable data only. An operation with a required function
   * parameter must NOT be declared — give it a construction-bound
   * default and declare the data-only signal form; keep the
   * function-arg variant as a plain in-process method.
   */
  protected command<I, R, E>(def: {
    /** Canonical verb — must be prefixed `"${this.surface}:"`. */
    readonly name: string;
    /** Standard Schema for the payload; validated at inbox dispatch. */
    readonly input?: StandardSchemaV1<I>;
    /** Reachability (ADR 51 §2.3). Default `"addressable"`. */
    readonly exposure?: CommandExposure;
    readonly description?: string;
    /**
     * Work-path scope dims for the Operation (surface-specific — e.g.
     * timeline supplies `() => ({ sessionId: this.scopeId })`). Receives
     * the command input so input-derived dims (e.g. tool dispatch's
     * `executionId` / `tickId` off `input.context`) are expressible;
     * static-scope declarations simply ignore the arg. The gate's
     * `origin` is merged in; `principal` is stamped by
     * {@link makeEvent} regardless.
     */
    readonly scope?: (input: I) => EventScope;
    /**
     * Deterministic opId derivation (ADR 51 idempotency). By default the
     * command manufactures a fresh `${name}:${ulid()}` opId per invocation.
     * A command whose re-invocation must be idempotent (e.g. tool dispatch,
     * keyed by the model's stable `toolCallId`) supplies a pure function of
     * the input so a repeat invocation hits the same opId and
     * `runOperation`'s `lookupTerminal` replays the cached terminal instead
     * of re-executing. Static/non-idempotent commands omit it.
     */
    readonly opId?: (input: I) => string;
    readonly handler: (input: I) => Effect.Effect<R, E, never>;
  }): (input: I, opts?: { readonly origin?: OperationOrigin }) => Promise<R> {
    const name = def.name;
    if (!name.startsWith(`${this.surface}:`)) {
      throw new CommandDeclarationError({
        command: name,
        reason: `verb prefix must match the declaring surface "${this.surface}"`,
      });
    }
    if (this.commandRegistry.has(name)) {
      throw new CommandDeclarationError({ command: name, reason: "duplicate declaration" });
    }
    const opName = `${this.surface}:command:${name.slice(this.surface.length + 1)}`;
    const run = (
      input: I,
      opts: {
        readonly origin: OperationOrigin;
        readonly parentOpId?: string;
        readonly correlationId?: string;
      },
    ): Effect.Effect<R, E | SubstrateError, never> =>
      this.runOperation<I, R, E>(
        {
          opId: def.opId?.(input) ?? `${name}:${ulid()}`,
          surface: this.surface,
          name: opName,
          ...omitUndefined({ parentOpId: opts.parentOpId, correlationId: opts.correlationId }),
          scope: omitUndefined({ ...(def.scope?.(input) ?? {}), origin: opts.origin }),
          input,
        },
        def.handler,
      );
    this.commandRegistry.set(name, {
      descriptor: {
        name,
        exposure: def.exposure ?? "addressable",
        ...omitUndefined({ input: def.input as StandardSchemaV1 | undefined }),
        ...omitUndefined({ description: def.description }),
      },
      run: run as RegisteredCommand["run"],
    });
    return (input, opts) => runHarnessProtocol(run(input, { origin: opts?.origin ?? "host" }));
  }

  /**
   * Effect-native invocation of a declared command — the intra-harness
   * composition path. A command body that nests another command
   * (timeline's `drain` appending via `timeline:append`) MUST stay in
   * the same fiber so the substrate auto-threads `parentOpId` onto the
   * nested envelopes (crossing `Effect.runPromise` via the public
   * method would sever the causality tree). Same registry entry, same
   * Operation manufacture as every other path.
   */
  protected commandEffect<I, R, E>(
    name: string,
    input: I,
    opts?: { readonly origin?: OperationOrigin },
  ): Effect.Effect<R, E | SubstrateError, never> {
    const reg = this.commandRegistry.get(name);
    if (reg === undefined) {
      throw new CommandDeclarationError({ command: name, reason: "not declared on this harness" });
    }
    return reg.run(input, { origin: opts?.origin ?? "host" }) as Effect.Effect<
      R,
      E | SubstrateError,
      never
    >;
  }

  /**
   * DRAFT(ADR 77/79 Stage 1) — the `.fx` surface: a `Proxy` that exposes each
   * declared command's **composable Effect twin** under its ergonomic action
   * name. `fxProxy()[action](input)` → `commandEffect("<surface>:<action>", …)`
   * — auto-derived from the command-naming convention (`<surface>:<action>`),
   * so there is no hand-maintained map. It returns the operation **Effect**
   * (NOT run to a Promise), so an in-process caller composes it with `yield*`
   * and stays in one fiber tree; the plain `harness.<action>()` Promise method
   * is the edge facade. A concrete harness exposes a typed `get fx()` over this.
   */
  protected fxProxy(): HarnessFx &
    Record<
      string,
      (
        input: unknown,
        opts?: { readonly origin?: OperationOrigin },
      ) => Effect.Effect<unknown, unknown, never>
    > {
    const surface = this.surface;
    return new Proxy(Object.create(null) as Record<string, never>, {
      get: (_t, action): unknown => {
        if (typeof action !== "string") return undefined;
        // `fx.use` — the Effect-native middleware register (HarnessFx),
        // universal across all `.fx` surfaces including the fxProxy-based ones.
        if (action === "use")
          return (mw: Middleware<unknown, unknown, unknown>) => this.registerEffectMiddleware(mw);
        return (input: unknown, opts?: { readonly origin?: OperationOrigin }) =>
          this.commandEffect(`${surface}:${action}`, input, opts);
      },
    }) as unknown as HarnessFx &
      Record<
        string,
        (
          input: unknown,
          opts?: { readonly origin?: OperationOrigin },
        ) => Effect.Effect<unknown, unknown, never>
      >;
  }

  /**
   * Enumerate declared commands (wire-safe summaries). Also served to
   * remote callers via the `"<surface>:commands"` meta-verb — the
   * declare-and-discover surface `commands/list` composes over.
   */
  commands(): readonly CommandInfo[] {
    return Array.from(this.commandRegistry.values(), ({ descriptor: d }) => ({
      name: d.name,
      exposure: d.exposure,
      hasInput: d.input !== undefined,
      ...omitUndefined({ description: d.description }),
    }));
  }

  /**
   * Inbox path for a declared command: validate against the declared
   * schema (the ONE validation site), stamp the delivering gate's
   * origin (default `"inbox"`), thread envelope causality, invoke
   * through the same `runOperation` path the public method uses.
   */
  private invokeRegisteredCommand(
    reg: RegisteredCommand,
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.gen(this, function* () {
      let input: unknown = msg.payload;
      const schema = reg.descriptor.input;
      if (schema !== undefined) {
        const raw = schema["~standard"].validate(msg.payload);
        const result = isThenable(raw)
          ? yield* Effect.promise(() => raw as Promise<Awaited<typeof raw>>)
          : raw;
        if (result.issues !== undefined) {
          return yield* Effect.fail(
            new InvalidPayload({
              reason: `command "${reg.descriptor.name}": ${result.issues
                .map((i) => i.message)
                .join("; ")}`,
            }),
          );
        }
        input = result.value;
      }
      return yield* reg
        .run(input, {
          origin: msg.origin ?? "inbox",
          ...omitUndefined({ parentOpId: msg.parentOpId, correlationId: msg.correlationId }),
        })
        .pipe(
          Effect.catchAll((cause) =>
            Effect.fail(cause instanceof MessageHandlerError ? cause : new HandlerError({ cause })),
          ),
        );
    });
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
      return custom(msg).pipe(Effect.catchAll((cause) => Effect.fail(new HandlerError({ cause }))));
    }
    // Command registry (ADR 51): declared, non-internal verbs are
    // inbox-addressable — validation + origin stamping + the same
    // runOperation path the public method uses. Replaces per-harness
    // `handleMessage` switch boilerplate; existing switches keep
    // working via the fallthrough below and migrate opportunistically.
    const registered = this.commandRegistry.get(msg.type);
    if (registered !== undefined && registered.descriptor.exposure !== "internal") {
      return this.invokeRegisteredCommand(registered, msg);
    }
    // Meta-verb (ADR 51 §2.4): enumerate declared commands. Wire-safe
    // summaries; the declare-and-discover surface. A subclass-declared
    // command of the same name (checked above) shadows this.
    if (msg.type === `${this.surface}:commands`) {
      return Effect.sync(() => this.commands());
    }
    return this.handleMessage(msg).pipe(
      Effect.catchAll((cause) => Effect.fail(new HandlerError({ cause }))),
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
      ...omitUndefined({ timeoutMs: opts.timeoutMs, signal: opts.signal }),
    });
    // Scope on the published envelope. Subscribers filter on
    // `scope.sessionId` etc.; harnesses that publish from within a
    // session pass `opts.scope` explicitly (e.g., ElicitationHarness
    // stamps its parent sessionId). Defaults to empty when the caller
    // doesn't supply one — per ADR 45 / #294 there's no longer an
    // implicit "captured at construction" fallback. Effect-typed
    // call sites should `yield* getContext` to populate scope if
    // they need it.
    const scope: EventScope = opts.scope ?? {};
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
      // Stamp the harness's construction-bound principal (ADR 48).
      // AUTHORITATIVE: a principal-bound harness overrides whatever the
      // operation carries — an op cannot emit an event claiming a
      // different principal than its harness (no per-op identity
      // spoofing, ADR 45). `omitUndefined` keeps the rebuilt scope
      // clean. Principal-less harnesses pass the op scope through
      // untouched (zero-cost — the universal hot path is unaffected).
      scope:
        this.principal !== undefined
          ? omitUndefined({ ...scope, principal: this.principal })
          : scope,
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
        return Effect.fail(new OperationOutcomeError({ outcome: "failed", terminal }));
      case "canceled":
        return Effect.fail(new OperationOutcomeError({ outcome: "canceled", terminal }));
      case "vetoed":
        return Effect.fail(new OperationOutcomeError({ outcome: "vetoed", terminal }));
      case "deferred":
        return Effect.fail(new OperationOutcomeError({ outcome: "deferred", terminal }));
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
 *
 * Subclass of {@link AgentickError} (ADR 41) — `err instanceof
 * AgentickError` narrows to the framework-error root.
 */
export class OperationOutcomeError extends AgentickError {
  readonly _tag = "OperationOutcomeError" as const;
  readonly outcome: CommandOutcome;
  readonly terminal: TerminalEvent;
  constructor(args: {
    readonly outcome: CommandOutcome;
    readonly terminal: TerminalEvent;
    readonly cause?: unknown;
  }) {
    super(`operation outcome: ${args.outcome}`, { cause: args.cause });
    this.outcome = args.outcome;
    this.terminal = args.terminal;
  }
}

registerAgentickError("OperationOutcomeError", OperationOutcomeError);

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
/**
 * Run an operation-bearing Effect to a Promise, normalizing the Exit.
 *
 * Optionally runs on a caller-provided `ManagedRuntime` (ADR 78) instead of
 * the default runtime — this is how the app-/node-scoped telemetry runtime
 * gets its tracer onto the substrate's `Effect.withSpan` annotations. When
 * `runtime` is omitted the behavior is identical to before (default runtime),
 * so every existing call site is unaffected.
 */
export async function runHarnessProtocol<R>(
  eff: Effect.Effect<R, unknown, never>,
  runtime?: ManagedRuntime.ManagedRuntime<never, never>,
): Promise<R> {
  const exit = await (runtime ? runtime.runPromiseExit(eff) : Effect.runPromiseExit(eff));
  return unwrapExit(exit) as R;
}

/**
 * Bridge a streaming operation's Effect-canonical form to the JS
 * {@link AsyncStream} facade — the streaming sibling of
 * {@link runHarnessProtocol}, and the singular concept behind EVERY
 * streaming edge (ADR 77).
 *
 * The canonical form is a **sink-fold**: `build(sink)` returns the Effect
 * that drives the work once, invoking `sink(item)` per emitted item and
 * succeeding with the final `Result`. In-process Effect callers compose
 * that Effect directly (one fiber, no bridge). This helper adds the
 * JS-shaped projection on top: it runs the Effect on a daemon fiber, tees
 * items into a bounded queue (real backpressure — a lagging iterator
 * consumer pauses the upstream via `Queue.offer`), and exposes both an
 * `AsyncIterable<Item>` and a `result` Promise reading the same fiber's
 * outcome. All the Queue/fork/Promise machinery lives HERE, once — a new
 * streaming edge supplies only its `build` and a couple of policy hooks.
 *
 * `result` and iteration observe ONE run. The iterator throws a real
 * provider failure (matching async-iterable ecosystem semantics) but
 * completes cleanly on cancellation — `options.isCancellation`
 * distinguishes the two (interrupts always complete cleanly). `abort`
 * interrupts the fiber; `onAbort` runs first for edge-specific bookkeeping.
 * `onStart` hands the running fiber to the edge (e.g. to register it for
 * an out-of-band `abort(id)` path). `runtime` threads a telemetry
 * `ManagedRuntime` the same way `runHarnessProtocol` does.
 */
export function runHarnessStream<Item, Result>(
  build: (sink: (item: Item) => Effect.Effect<void>) => Effect.Effect<Result, unknown, never>,
  options?: {
    readonly queueCapacity?: number;
    readonly isCancellation?: (cause: unknown) => boolean;
    readonly onStart?: (fiber: Fiber.RuntimeFiber<Result, unknown>) => void;
    readonly onAbort?: (reason: string) => void;
    readonly runtime?: ManagedRuntime.ManagedRuntime<never, never>;
  },
): AsyncStream<Item, Result> {
  const capacity = options?.queueCapacity ?? 16;
  const isCancellation = options?.isCancellation ?? ((): boolean => false);
  const run = <A>(eff: Effect.Effect<A, never, never>): Promise<A> =>
    options?.runtime ? options.runtime.runPromise(eff) : Effect.runPromise(eff);

  type QItem = Option.Option<Item>;
  type QF = { queue: Queue.Queue<QItem>; fiber: Fiber.RuntimeFiber<Result, unknown> };

  // Setup runs once; the daemon fiber outlives it so the iterator and
  // `result` can both observe the same outcome. `None` terminates the
  // queue whatever the fiber's exit (success / failure / interrupt).
  const program = Effect.gen(function* () {
    const queue = yield* Queue.bounded<QItem>(capacity);
    const sink = (item: Item): Effect.Effect<void> =>
      Queue.offer(queue, Option.some(item)).pipe(Effect.asVoid);
    const runEffect = build(sink).pipe(Effect.ensuring(Queue.offer(queue, Option.none<Item>())));
    const fiber = yield* Effect.forkDaemon(runEffect);
    return { queue, fiber } satisfies QF;
  });

  let resolveQF!: (v: QF) => void;
  let rejectQF!: (e: unknown) => void;
  const ready = new Promise<QF>((res, rej) => {
    resolveQF = res;
    rejectQF = rej;
  });
  void run(program).then((qf) => {
    resolveQF(qf);
    options?.onStart?.(qf.fiber);
  }, rejectQF);

  const result: Promise<Result> = ready.then(({ fiber }) =>
    run(Fiber.await(fiber)).then((exit) => unwrapExit(exit) as Result),
  );
  // The caller may never await `.result`; don't let Node flag it.
  result.catch(() => {});

  return {
    result,
    abort: (reason) => {
      options?.onAbort?.(reason ?? "aborted");
      void ready.then(({ fiber }) => run(Fiber.interrupt(fiber)));
    },
    [Symbol.asyncIterator](): AsyncIterator<Item> {
      return {
        next: async (): Promise<IteratorResult<Item>> => {
          const { queue, fiber } = await ready;
          const item = await run(Queue.take(queue)).catch(() => Option.none<Item>());
          if (Option.isNone(item)) {
            const exit = await run(Fiber.await(fiber));
            if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
              const cause = Cause.squash(exit.cause);
              if (!isCancellation(cause)) throw cause;
            }
            return { value: undefined as unknown as Item, done: true };
          }
          return { value: item.value, done: false };
        },
        return: async (): Promise<IteratorResult<Item>> => {
          try {
            const { fiber, queue } = await ready;
            await run(Fiber.interrupt(fiber));
            await run(Queue.shutdown(queue));
          } catch {
            // ignore — caller is closing iteration
          }
          return { value: undefined as unknown as Item, done: true };
        },
      };
    },
  };
}
