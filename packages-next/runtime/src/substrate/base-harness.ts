/**
 * BaseHarness — the inheritance point every concrete harness sits on.
 *
 * Composes journal + bus + inbox into the four-surface model:
 *
 *   ① Commands     — `runOperation` (heavy path with phase contract,
 *                    idempotency, journaling, observability)
 *   ② Inbox        — `handleMessage` (concrete subclass implements)
 *   ③ Interceptors — ONE composed seam around every command (ADR 83):
 *                    `.guard()` (admission), `.use(mw)` (middleware), and
 *                    hooks (keyed transform) — three kinds of one `Middleware`,
 *                    inherited via LIVE inheritance down the construction tree
 *                    (ADR 83 §4): a registration on a harness pushes to every
 *                    live descendant, and a new descendant pulls the current set
 *   ④ Events       — `emit` (light path) + `emitDelta` (in-flight)
 *
 * Substrate-internal API is Effect-typed end-to-end. Concrete harnesses
 * MAY expose Promise-typed protocol surfaces (e.g., CompilerProtocol)
 * by wrapping their command bodies with `Effect.runPromise` at the
 * public method boundary. The FiberRef scope (`RuntimeContextRef`) is
 * established by `runOperation` for the lifetime of the command — any
 * Effect launched within the body sees the active sessionId,
 * executionId, tickId, opId, parentOpId, correlationId via `getContext`.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §`BaseHarness` — the inheritance point
 * @see docs/proposals/v2/blueprint/01-harness-principle.md
 */

import { Effect, Fiber } from "effect";
import { omitUndefined, isThenable } from "@agentick/utils-next";
import type {
  AfterHook,
  BeforeHook,
  ChunkInterceptor,
  EventBus,
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
  StoreCtx,
  SubstrateError,
  Unsubscribe,
} from "@agentick/spec-next";
import {
  DEFAULT_JOURNALING_POLICY,
  logEventName,
  parseHookKey,
  progressEventName,
  HandlerError,
  InvalidPayload,
  MessageHandlerError,
} from "@agentick/spec-next";
import { resolveSyncSubstrateSlot } from "./resolve-slot.js";
import { ulid } from "./ulid.js";
import { getContext, type RuntimeContext } from "./runtime-context.js";
import { runHarnessProtocol, runHarnessStream } from "./harness-protocol.js";
import {
  createCommandRunner,
  type CommandRunner,
  type RegisteredCommand,
  type StreamCommand,
} from "./command-runner.js";
import { RequestResponseRegistry, type RequestError } from "./request-response-registry.js";
import {
  type InterceptorKind,
  type OperationSignal,
  interceptorKind,
  orderInterceptors,
  signalFromVerdict,
  tagInterceptor,
} from "./op-signals.js";
import { createOperationRunner, type OperationRunner } from "./operation-runner.js";

export {
  OperationVeto,
  OperationDefer,
  OperationReplace,
  isOperationSignal,
  interceptorKind,
  orderInterceptors,
  signalFromVerdict,
  tagInterceptor,
  type InterceptorKind,
  type OperationSignal,
} from "./op-signals.js";

// The operation-execution substrate (Tier 2 — the heavy path, terminal
// machinery, tier-4 call-scoped middleware, and `OperationOutcomeError` whose
// class home is this package) was extracted to `operation-runner.ts`; re-export
// here so `@agentick/runtime-next`'s public surface is unchanged — a re-home,
// not a public-API change.
export {
  createOperationRunner,
  OperationOutcomeError,
  type OperationRunner,
  type OperationRunnerDeps,
  type RunOperation,
} from "./operation-runner.js";

export type { Unsubscribe } from "@agentick/spec-next";

// Re-export the pure hook-derivation pieces moved to `@agentick/spec-next`
// (ADR 80) so downstream `@agentick/runtime-next` imports keep resolving —
// the move is a re-home, not a public-surface change.
export { deriveHookNames, deriveChunkHookName } from "@agentick/spec-next";
export type { BeforeHook, AfterHook } from "@agentick/spec-next";
// Per-chunk interception (ADR 80 Phase 2) — the sink-wrapping interceptor shapes
// a streaming command's `on<Verb>Chunk` hook / `def.chunk` option accepts.
export type { ChunkInterceptor, ChunkObserver, ChunkTransform } from "@agentick/spec-next";
// The streaming-edge facade type — `commandStream` and `runHarnessStream` both
// surface it, so re-home it onto the runtime package's public API (ADR 77).
export type { AsyncStream } from "@agentick/spec-next";

// The Effect→JS protocol bridges + the command subsystem were extracted (A2.4)
// to `harness-protocol.ts` / `command-runner.ts`; re-export here so the package's
// public surface (`@agentick/runtime-next`) is unchanged — a re-home, not a
// public-API change.
export { runHarnessProtocol, runHarnessStream } from "./harness-protocol.js";
export {
  createCommandRunner,
  type CommandRunner,
  type CommandRunnerDeps,
  type CommandDef,
  type StreamCommandDef,
  type StreamCommand,
  type RegisteredCommand,
  type CommandInvokeOpts,
} from "./command-runner.js";

/**
 * Effect-native guard decider (ADR 83). The Effect twin of the
 * {@link BaseHarness.guard} sugar's decider: receives the command's input plus
 * the op's {@link RuntimeContext}, returns a {@link HandlerVerdict} (or `void`
 * ≡ `proceed`) on the Effect success channel. Desugared to a `guard`-kind
 * interceptor by {@link BaseHarness.guardEffect}.
 */
export type GuardDecider<I = unknown, R = unknown, E = never> = (
  input: I,
  ctx: RuntimeContext,
) => Effect.Effect<HandlerVerdict<R> | void, E, never>;

// `Middleware` (Effect-native, `fx.use`) + `HarnessFx` are defined in
// `@agentick/spec-next` (so the `XFx` protocols can type `fx.use`) and
// re-exported here. `AsyncMiddleware` (pure-JS, `use`) lives in `middleware.ts`
// — it carries `RuntimeContext`, a runtime concern.
export type { Middleware, HarnessFx } from "@agentick/spec-next";

// The middleware COMPOSITION primitives (chain, compose, lift, hook-desugaring,
// tier-4 call-scoped FiberRef) + the typed command-hook derivation were
// extracted to `middleware.ts`. BaseHarness imports the pieces it uses in its
// body (it HOLDS `MiddlewareChain` instances and PROPAGATES them per ADR 83 §4,
// but the primitives live there); the public surface is re-exported below
// byte-unchanged — a re-home, not a public-API change.
import {
  MiddlewareChain,
  liftMiddleware,
  commandHookMiddleware,
  type AsyncMiddleware,
  type CommandHooks,
  type HookRegistrars,
} from "./middleware.js";
export {
  MiddlewareChain,
  composeMiddleware,
  liftMiddleware,
  scopeToCommand,
  hooksToMiddlewares,
  withCallMiddleware,
  type AsyncMiddleware,
  type CommandHooks,
  type CommandMiddlewares,
  type CommandRegistry,
  type HookRegistrars,
} from "./middleware.js";

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

export interface BaseHarnessOptions<I = unknown> {
  readonly policy?: JournalingPolicy;
  /**
   * Auto-register on the inbox at construction. Set false for harnesses
   * that handle their own registration timing. Default: true.
   */
  readonly autoRegisterInbox?: boolean;
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
  /**
   * The parent scope's resolved interceptor snapshot (ADR 76 tier 3 + ADR 83
   * amendment), folded in at construction. Guards, `.use` transforms, AND
   * declarative command hooks (adapted to op-scoped middleware via
   * {@link hooksToMiddlewares}) all inherit through this ONE seam — the caller
   * computes the value once (`parent.resolvedInterceptors()`, plus any session
   * config hooks) and hands it down, so no op
   * ever walks a construction-parent chain. Composed OUTERMOST of this
   * harness's own middleware (broader scope first). Defaults to `[]`.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * The construction parent for LIVE interceptor inheritance (ADR 83 §4).
   * When set, this harness registers itself as a live child of the parent at
   * construction — so an interceptor registered on the parent AFTER this
   * harness exists (`.use` / `.guard` / `.hook`) propagates DOWN to it (and its
   * own descendants), and the parent's unsubscribe cascades the removal back.
   * The one-time construction snapshot ({@link inheritedInterceptors}) seeds the
   * initial set; this keeps the relation live thereafter. The parent passes
   * `interceptorParent: this` alongside `inheritedInterceptors:
   * this.resolvedInterceptors()` — both synchronous in the child ctor, so no
   * registration can slip between the pull-seed and the attach. Omit for a
   * top-of-tree harness (no parent to inherit from).
   */
  readonly interceptorParent?: BaseHarness<EventSurface, unknown>;
}

export abstract class BaseHarness<Surface extends EventSurface = EventSurface, Input = unknown> {
  /**
   * Cluster-portable inbox address — `${surface}:${scopeId}`. Public
   * so other harnesses can send `inbox.send(address, ...)` messages
   * without indirection through protocol-specific accessors.
   * Cluster-aware inboxes route to whichever node owns the address.
   */
  public readonly address: string;
  protected readonly middleware = new MiddlewareChain();

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
  /**
   * The parent scope's inherited interceptor layer (ADR 76 tier 3 + ADR 83 §4)
   * as a LIVE holder — no longer a frozen array. Seeded at construction from the
   * parent's `resolvedInterceptors()` snapshot ({@link BaseHarnessOptions.inheritedInterceptors}),
   * then kept live: a later registration on the parent pushes into this chain
   * (via {@link acceptInheritedInterceptor}) and the parent's unsubscribe removes
   * it by identity (via {@link removeInheritedInterceptor}). Guards, `.use`
   * transforms, AND command hooks (ADR 83 amendment — hooks are op-scoped
   * `transform` middleware) all inherit through this ONE seam. Composed OUTERMOST
   * of this harness's own `this.middleware` per op; empty when top-of-tree. Read
   * per op as `this.inherited.snapshot()` — no parent-walk.
   * @see BaseHarnessOptions.inheritedInterceptors
   */
  private readonly inherited = new MiddlewareChain();

  /**
   * Live interceptor descendants (ADR 83 §4). A child registers here at
   * construction (via {@link attachInterceptorChild}) when it passes
   * `interceptorParent: this`; a registration on THIS harness then pushes down
   * to each, and their teardown ({@link close}) removes them so no push ever
   * hits a torn-down harness. Distinct from the substrate/close cascade — this
   * tracks the interceptor-inheritance edge only.
   */
  private readonly interceptorChildren = new Set<BaseHarness>();

  /**
   * Detach this harness from its interceptor parent's {@link interceptorChildren}
   * set — captured at construction when `interceptorParent` was supplied, fired
   * at {@link close}. A closure rather than a stored parent pointer (ADR 81
   * deleted the parent pointer; this restores only a forwarding edge, not a
   * back-reference that survives teardown).
   */
  private detachFromInterceptorParent?: Unsubscribe;
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
    return this.registerOwn(liftMiddleware(mw) as Middleware<unknown, unknown, unknown>);
  }

  /**
   * The SINGLE own-registration funnel (ADR 83 §4) behind `.use` / `.fx.use` /
   * `.guard` / `.hook`. Registers `mw` on this harness's OWN chain, then PUSHES
   * it to every live interceptor child (which appends to its inherited layer and
   * recurses to grandchildren). The returned {@link Unsubscribe} removes the own
   * registration AND cascades the removal into all CURRENT descendants by
   * interceptor identity at call time — so it also unhooks descendants
   * constructed AFTER this registration (which pulled `mw` via the fold). No-op
   * when nothing subscribes.
   */
  private registerOwn(mw: Middleware<unknown, unknown, unknown>): Unsubscribe {
    const ownUnsub = this.middleware.use(mw);
    for (const child of this.interceptorChildren) child.acceptInheritedInterceptor(mw);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      ownUnsub();
      for (const child of this.interceptorChildren) child.removeInheritedInterceptor(mw);
    };
  }

  /**
   * Register a live interceptor child (ADR 83 §4). Called by the child's ctor
   * (`interceptorParent.attachInterceptorChild(this)`) AFTER it has pull-seeded
   * its inherited layer. Returns the detach thunk the child fires at
   * {@link close}. Idempotent per child (Set semantics).
   */
  private attachInterceptorChild(child: BaseHarness): Unsubscribe {
    this.interceptorChildren.add(child);
    return () => {
      this.interceptorChildren.delete(child);
    };
  }

  /**
   * Receive an interceptor pushed from the parent (ADR 83 §4): append to this
   * harness's inherited layer and recurse to its own live children
   * (grandchildren). Same reference throughout, so the interceptor-kind tag
   * ({@link tagInterceptor}) rides along.
   */
  private acceptInheritedInterceptor(mw: Middleware<unknown, unknown, unknown>): void {
    this.inherited.use(mw);
    for (const child of this.interceptorChildren) child.acceptInheritedInterceptor(mw);
  }

  /**
   * Remove a parent-pushed interceptor by identity (ADR 83 §4): drop it from this
   * harness's inherited layer and recurse to grandchildren. The cascade half of
   * {@link registerOwn}'s unsubscribe.
   */
  private removeInheritedInterceptor(mw: Middleware<unknown, unknown, unknown>): void {
    this.inherited.remove(mw);
    for (const child of this.interceptorChildren) child.removeInheritedInterceptor(mw);
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
    return this.registerOwn(mw as Middleware<unknown, unknown, unknown>);
  }

  /**
   * ADR 76/83 — structural interceptor inheritance (tier 3), now a LIVE relation.
   *
   * The value a parent hands its children AT CONSTRUCTION: this harness's
   * inherited layer followed by its OWN registered middleware, ordered
   * **root-outermost** — `[...inherited, ...ownMiddleware]`. A child pull-seeds
   * this at ITS construction (`inheritedInterceptors: parent.resolvedInterceptors()`)
   * — so it inherits everything registered before it existed — AND (via
   * `interceptorParent: parent`) registers as a live child so registrations made
   * on the parent AFTER it exists push down too (ADR 83 §4). The per-op read is
   * still local (`this.inherited.snapshot()` + own) — no parent-walk.
   *
   * Guards (`.guard()`), transforms (`.use()`), AND command hooks (`.hook()` —
   * op-scoped `transform` middleware, ADR 83 amendment) all live on
   * `this.middleware`, so all inherit through this one seam.
   */
  protected resolvedInterceptors(): readonly Middleware<unknown, unknown, unknown>[] {
    // Inherited layer is broader scope → outermost → first in the list.
    return [...this.inherited.snapshot(), ...this.middleware.snapshot()];
  }

  /**
   * Register a GUARD interceptor (ADR 83) — the named seam that
   * re-expresses the old before-verdict handler. A guard decides
   * (`proceed` / `veto` / `replace` / `defer`) BEFORE the body runs; it is a
   * `guard`-kind {@link Middleware} that either calls `next` (proceed) or raises
   * an {@link OperationSignal} that `runOperation` maps to the matching terminal
   * (`vetoed` / `replaced` / `deferred`).
   *
   * The ergonomic surface: a decider returning a {@link HandlerVerdict} (or
   * `void` ≡ proceed), sync or Promise. Guards compose OUTERMOST of all
   * interceptors (deny-before-transform), and are inherited across
   * construction-ancestors the same way `.use()` middleware is (they live on
   * the same chain). Returns {@link Unsubscribe}.
   *
   * ```ts
   * harness.guard((input, ctx) =>
   *   input.locked ? { kind: "veto", reason: "locked" } : undefined,
   * );
   * ```
   */
  guard<I = unknown, R = unknown>(
    decide: (
      input: I,
      ctx: RuntimeContext,
    ) => HandlerVerdict<R> | void | Promise<HandlerVerdict<R> | void>,
  ): Unsubscribe {
    return this.guardEffect<I, R>((input, ctx) =>
      Effect.suspend(() => {
        const raw = decide(input, ctx);
        return isThenable(raw)
          ? Effect.promise(() => raw as Promise<HandlerVerdict<R> | void>)
          : Effect.succeed(raw as HandlerVerdict<R> | void);
      }),
    );
  }

  /**
   * Effect-native {@link guard} — the composition path for a decider that is
   * already an Effect (e.g. the tool-executor's `guardDispatch`, which runs
   * its verdict logic in-fiber). Builds ONE `guard`-kind interceptor that reads
   * the op's ambient {@link RuntimeContext}, runs the decider, and either
   * proceeds or raises the desugared control-signal. This is the SOLE place a
   * verdict becomes a signal.
   */
  protected guardEffect<I, R>(decide: GuardDecider<I, R, unknown>): Unsubscribe {
    const mw: Middleware<I, R, unknown> = (input, next) =>
      Effect.gen(function* () {
        const ctx = yield* getContext;
        const verdict = (yield* decide(input, ctx)) ?? ({ kind: "proceed" } as const);
        if (verdict.kind === "proceed") return yield* next(input);
        // Raise the control-signal on the failure channel — `runOperation`'s
        // settle step catches it and emits the terminal. Because guards compose
        // outermost, no transform (retry) middleware can swallow it.
        return yield* Effect.fail(signalFromVerdict(verdict));
      });
    return this.registerOwn(tagInterceptor("guard", mw) as Middleware<unknown, unknown, unknown>);
  }

  /**
   * Register ONE command hook config entry onto this harness's `.use` chain
   * (ADR 83 amendment) — the shared impl behind {@link hook} and the
   * {@link hooks} proxy. Desugars the key via {@link commandHookMiddleware}
   * (before/after → sugar, bare `on<Command>` → the middleware as-is), op-scopes
   * it by `ctx.op`, and registers it as a `transform`-kind middleware. The
   * returned {@link Unsubscribe} is the chain's native remover — a hook is now
   * just op-scoped middleware, no separate `Hooks` storage.
   */
  private registerCommandHook(key: string, fn: unknown): Unsubscribe {
    const mw = commandHookMiddleware(key, fn);
    if (mw === undefined) return () => {};
    return this.registerOwn(mw);
  }

  /**
   * Dispatch ONE hook-config entry to its registration path (ADR 80 Phase 2):
   * an `on<Verb>Chunk` key routes to the {@link CommandRunner}'s
   * `registerChunkInterceptor` (the sink-wrapping path, since chunk state is
   * command-scoped); every other key routes to {@link registerCommandHook}
   * (the op-scoped middleware cascade). The single funnel behind {@link hook}
   * and the {@link hooks} proxy.
   */
  private registerHookEntry(key: string, fn: unknown): Unsubscribe {
    if (parseHookKey(key)?.kind === "chunk") {
      return this.commandRunner.registerChunkInterceptor(
        key,
        fn as ChunkInterceptor<unknown, RuntimeContext>,
      );
    }
    return this.registerCommandHook(key, fn);
  }

  /**
   * Register command lifecycle hooks IMPERATIVELY (ADR 83) — the runtime twin of
   * the declarative `{ hooks }` construction config, taking the SAME
   * {@link CommandHooks} object. Each entry registers as an op-scoped
   * `transform` middleware on this harness's OWN `.use` chain; the returned
   * {@link Unsubscribe} removes exactly those middlewares. Affects this
   * harness's OWN future ops; like `use`/`guard`, it does NOT retroactively
   * reach already-constructed children (the fold snapshot).
   *
   * ```ts
   * const off = harness.hook({ onBeforeToolDispatch: (input) => reshape(input) });
   * off(); // remove
   * ```
   *
   * Prefer {@link BaseHarness.hooks} for the per-verb call style
   * (`harness.hooks.onBeforeToolDispatch(fn)`), which is a Proxy over this.
   */
  hook(config: CommandHooks): Unsubscribe {
    const unsubs: Unsubscribe[] = [];
    for (const [key, fn] of Object.entries(config as Record<string, unknown>)) {
      if (fn === undefined) continue;
      unsubs.push(this.registerHookEntry(key, fn));
    }
    if (unsubs.length === 0) return () => {};
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      for (const off of unsubs) off();
    };
  }

  /**
   * Per-verb imperative registrars (ADR 83) — a typed Proxy over
   * {@link registerHookEntry}. Uniformly covers the before/after sugar
   * (`harness.hooks.onBeforeToolDispatch(fn)`), the full-middleware `on<Command>`
   * primitive (`harness.hooks.onToolDispatch(mw)`), AND the per-chunk interceptor
   * (`harness.hooks.onModelGenerateStreamChunk(interceptor)`, ADR 80 Phase 2 —
   * routed to the sink-wrapping path), each returning its {@link Unsubscribe}.
   * Only augmented verbs are callable keys ({@link HookRegistrars}); an unknown
   * name is an inert no-op.
   */
  get hooks(): HookRegistrars {
    return (this._hookRegistrars ??= new Proxy({} as HookRegistrars, {
      get: (_target, name) =>
        typeof name === "string" ? (fn: unknown) => this.registerHookEntry(name, fn) : undefined,
    }));
  }
  private _hookRegistrars?: HookRegistrars;

  /**
   * INTROSPECTION (ADR 83) — enumerate the effective interceptor
   * kinds for `opName`, in composed (outermost-first) order after the
   * guard-outermost sort. Proves the collapsed seam stays enumerable: guards,
   * transforms, and observers are one list, not two disjoint mechanisms. Omits
   * the tier-4 (FiberRef) call-scoped middleware, which is only resolvable
   * in-fiber.
   */
  listInterceptors(_opName: string): InterceptorKind[] {
    // Hooks now live on `this.middleware` as op-scoped `transform` middlewares
    // (ADR 83 amendment), so `resolvedInterceptors()` already includes them —
    // no separate hook-layer term. Each hook enumerates as `transform`
    // regardless of `_opName` (the op-scoping is a runtime `ctx.op` compare,
    // opaque to static kind introspection).
    const assembled = [...this.inherited.snapshot(), ...this.middleware.snapshot()];
    return orderInterceptors(assembled).map(interceptorKind);
  }

  /**
   * Substrate used by this harness. Set from positional defaults
   * (the parent's substrate, passed in as ctor args) unless an
   * override is supplied in `options.{bus,inbox,journal}`.
   */
  protected readonly journal: OperationJournal;
  protected readonly bus: EventBus;
  protected readonly inbox: MessageInbox;

  /**
   * The operation-execution substrate (Tier 2) as a per-harness instance —
   * owns the phase contract, idempotency replay, the interceptor cascade,
   * identity stamping, journaling/bus routing, and the terminal machinery.
   * Constructed AFTER substrate resolution (it captures `this.journal` /
   * `this.bus`) with two injected construction-tree closures (`interceptors`
   * for the LIVE tier-2/3 snapshot, `spanAttributes` for the overridable OTel
   * seam). `runOperation` and the light-path emitters delegate onto this.
   */
  private readonly operationRunner: OperationRunner;

  /**
   * The command subsystem (ADR 51 + A2.4) as a per-harness instance — owns the
   * registry, the command manufacture, `commands()`, `get(name)`, and the
   * per-command chunk-interceptor lists. Constructed with THIS harness's bound
   * {@link runOperation} (the {@link operationRunner}'s heavy path): the injected
   * capability is the ONLY seam between the command-declaration layer (the
   * runner) and the operation-execution layer. The public `command` /
   * `commandStream` / `commandEffect` / `commands` methods and the inbox dispatch
   * path are thin delegations onto this.
   */
  private readonly commandRunner: CommandRunner;

  constructor(
    protected readonly surface: Surface,
    protected readonly scopeId: string,
    defaultJournal: OperationJournal,
    defaultBus: EventBus,
    defaultInbox: MessageInbox,
    options: BaseHarnessOptions<Input> = {},
  ) {
    this.address = `${surface}:${scopeId}`;
    this.policy = options.policy ?? DEFAULT_JOURNALING_POLICY;
    this.input = options.input;
    this.metadata = Object.freeze({ ...(options.metadata ?? {}) });
    this.principal = options.principal;
    this.telemetryNamespace = options.telemetryNamespace ?? "agentick";
    // ADR 83 §4 — LIVE interceptor inheritance. Pull-seed the inherited layer
    // from the parent's construction-time snapshot, THEN register as a live
    // child of the parent. Both are synchronous here, so no interceptor can be
    // registered on the parent between the snapshot and the attach (which would
    // otherwise be missed or double-counted). Thereafter parent registrations
    // push down live and its unsubscribe cascades the removal (`registerOwn`).
    for (const mw of options.inheritedInterceptors ?? []) this.inherited.use(mw);
    if (options.interceptorParent !== undefined) {
      this.detachFromInterceptorParent = options.interceptorParent.attachInterceptorChild(this);
    }

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

    // Operation-execution substrate (Tier 2). Constructed here — after the
    // journal/bus slots are resolved — with the two construction-tree closures
    // it cannot own: `interceptors` reads the LIVE tier-2 (`.use`/`.guard`/
    // `.hook`) + tier-3 (inherited) snapshot per op (ADR 83 §4 live
    // inheritance is harness state), and `spanAttributes` reaches the harness's
    // overridable OTel seam. The command runner then binds this runner's
    // `runOperation` as its sole injected capability.
    this.operationRunner = createOperationRunner({
      surface,
      principal: this.principal,
      journal: this.journal,
      bus: this.bus,
      policy: this.policy,
      interceptors: () => [...this.inherited.snapshot(), ...this.middleware.snapshot()],
      spanAttributes: (op) => this.spanAttributes(op),
    });
    this.commandRunner = createCommandRunner({
      surface,
      runOperation: this.operationRunner.runOperation,
    });

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
   * Build the {@link StoreCtx} threaded (as the FINAL argument) into every store
   * DATA-method call this harness makes — the explicit runtime-scope carrier
   * across the **Effect→Promise boundary** a Promise-shaped store lives behind
   * (it cannot read the ambient `RuntimeContext` FiberRef off-fiber).
   *
   * Run A builds the BASE from construction slots only: the harness's scope id
   * (as `sessionId` — the store-backed harnesses are session-scoped; a harness
   * whose scope key differs overrides this), the construction-bound `principal`
   * when present, and the harness's journal as the READ-slice `journalReader`
   * (`OperationJournal` is structurally a {@link JournalReader}, so `this.journal`
   * passes with no adapter — it is the event-sourcing fold input a derived store
   * consumes in Run B). Run B enriches this with the live `getContext` snapshot
   * (opId as idempotency key, correlationId, traceparent) at the op boundary.
   */
  protected storeCtx(): StoreCtx {
    return {
      sessionId: this.scopeId,
      ...(this.principal !== undefined ? { principal: this.principal } : {}),
      journalReader: this.journal,
    };
  }

  /**
   * The Effect-side twin of {@link storeCtx} — the ENRICHED {@link StoreCtx} a
   * write-path command handler threads to a store mutation. Run B: fold the
   * live ambient {@link RuntimeContext} (read from the FiberRef via `getContext`)
   * over the construction-slot base, so `opId` (the idempotency key), the
   * causality `parentOpId`, the request `correlationId`, and W3C `traceparent`
   * reach the store the moment it crosses the Effect→Promise boundary.
   *
   * Only reachable from INSIDE an Effect fiber (a command handler running under
   * `runOperation`) — that is exactly where the ambient scope is live. The base
   * fields win on the store-only slots the runtime context does not carry
   * (`journalReader`); the ambient scope wins on the identity/operation fields,
   * which is the whole point (it carries the CURRENT op's `opId`, not a
   * construction-time blank). A `RuntimeContext` value is structurally
   * assignable to `StoreCtx` (every field `StoreCtx` adds is optional), so the
   * spread merges with no adapter.
   *
   * Sync-only write sites that cannot reach a fiber (`hydrate`,
   * `importSnapshot`, `app/run.ts`) keep the base {@link storeCtx} — they carry
   * no live op to enrich from.
   */
  protected storeCtxEffect(): Effect.Effect<StoreCtx> {
    return Effect.map(getContext, (rc) => ({ ...this.storeCtx(), ...rc }));
  }

  // ──────── ① Commands (heavy path) ────────

  /**
   * Run an operation through the full phase contract (idempotency → requested →
   * before → interceptor cascade → terminal) — a thin delegation onto this
   * harness's {@link operationRunner} (Tier 2). Kept as a `protected` method so
   * subclasses invoke `this.runOperation(op, body)` unchanged; the executor,
   * the phase contract, and the FiberRef context scope all live on the runner.
   *
   * The runner establishes the `RuntimeContextRef` FiberRef for the command's
   * lifetime — sessionId/executionId/tickId/opId/parentOpId/correlationId from
   * `op.scope` are visible to any downstream Effect via `getContext` — and
   * settles non-success terminals (failed, canceled, vetoed, deferred) onto the
   * `E` channel as `OperationOutcomeError`.
   */
  protected runOperation<I, R, E>(
    op: Operation<I, R, E>,
    body: (input: I) => Effect.Effect<R, E, never>,
  ): Effect.Effect<R, E | SubstrateError, never> {
    return this.operationRunner.runOperation(op, body);
  }

  /**
   * Span attributes attached to every operation's OTel span. Exporters
   * (subscribed via `@effect/opentelemetry`) see these on the span.
   * Override in concrete harnesses to add domain attributes.
   *
   * Kept ON the harness (not absorbed into the {@link operationRunner}) so this
   * override seam survives the Tier-2 extraction; the runner reaches it via the
   * injected `spanAttributes` closure and owns the `Effect.withSpan` wrap.
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
    return this.operationRunner.publish(envelope);
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
    const decision = this.operationRunner.decideFromShape(key.name, key.phase);
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
    return this.operationRunner.publish(
      this.operationRunner.makeEvent(op, "delta", op.scope ?? {}, { payload }),
    );
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
    const decision = this.operationRunner.decideFromShape(op.name, "delta");
    if (decision === "drop") return Effect.void;
    if (decision === "always" || decision === "journal") {
      return this.operationRunner.publish(
        this.operationRunner.makeEvent(op, "delta", op.scope ?? {}, { payload: buildPayload() }),
      );
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
    return this.operationRunner.publish(
      this.operationRunner.makeEvent(op, "delta", op.scope ?? {}, { payload: buildPayload() }),
    );
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

  // ──────── command registry (ADR 51) — delegated to CommandRunner (A2.4) ────────
  //
  // The registry Map, command manufacture, `commands()` listing, inbox lookup,
  // and the per-command chunk-interceptor lists all live on `this.commandRunner`
  // (constructed with this harness's bound `runOperation`). The methods below are
  // thin, signature-preserving delegations — the protected surface subclasses see
  // is unchanged.

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
    return this.commandRunner.command<I, R, E>(def);
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
    return this.commandRunner.commandEffect<I, R, E>(name, input, opts);
  }

  /**
   * Declare a STREAMING command — the streaming twin of {@link command}
   * (ADR 51 §2 + ADR 77 dual-typed edge). Fuses the three things `command`
   * and {@link runHarnessStream} each half-provide into ONE declaration site:
   *
   *   1. **Registry registration** — identical to {@link command} (same
   *      surface-prefix check, same duplicate check, same
   *      `opName = "${surface}:command:${verb}"`, same registry set on the
   *      shared {@link CommandRunner}). This is what mints the boundary hooks
   *      `onBefore<Verb>` / `onAfter<Verb>` (ADR 80) and makes the verb
   *      inbox-addressable.
   *   2. **Interceptor cascade** — the body runs INSIDE {@link runOperation}
   *      exactly as a normal command's does. The ONE composed interceptor list
   *      (guard → onBefore(input) → body → onAfter(R)) fires at the stream's
   *      START (guard/onBefore bracket the first chunk) and TERMINAL (onAfter
   *      over the finished `R`, then `terminal:succeeded`). There is NO second
   *      interceptor path — this reuses `runOperation` verbatim.
   *   3. **Async-iterator machinery** — the public method projects the
   *      cascade-wrapped body onto the JS {@link AsyncStream} facade via
   *      {@link runHarnessStream} (Queue / `forkDaemon` / `.result` / `abort`
   *      all live there, once).
   *
   * **The body-emits-to-sink contract.** `body(input, sink)` emits each chunk
   * as a side-effect (`sink(chunk)`) and RETURNS the final result `R`. The
   * cascade applies to the boundary only: `input` is already guard-admitted +
   * onBefore-transformed; the returned `R` is onAfter-transformed. Chunks flow
   * out the sink concurrently and are NOT intercepted here.
   *
   * **Per-chunk interception (ADR 80 Phase 2).** Beyond the boundary hooks, a
   * streaming command mints an `on<Verb>Chunk` registrar (via
   * {@link deriveChunkHookName}, e.g. `onModelGenerateStreamChunk`) and accepts a
   * `def.chunk` list — both take {@link ChunkInterceptor}s that SINK-WRAP the
   * body's sink. An `observe` interceptor taps each chunk in order; a `transform`
   * maps/coalesces (its `onChunk(chunk, emit)` may emit zero/one/many) with an
   * optional `onFlush(emit)` released at the terminal boundary (after the body's
   * last emit, BEFORE `onAfter` — the flush-on-terminal contract). Because the
   * wrap is on the SINK, ALL THREE faces (`stream`, `fx`, `run`) see transformed
   * chunks. When no interceptor is registered the sink is not wrapped at all
   * (zero overhead). An aborted body never reaches `flush` (no bogus tail).
   *
   * **Three consumption faces, ONE cascade** — the returned {@link StreamCommand}
   * exposes all three; each drives the same single cascade-wrapped run:
   *   - **`fx`** — the Effect-native **sink-fold twin** (`fx(input, sink) =>
   *     Effect<R>`). EXACTLY the internal cascade-wrapped body, un-run and
   *     bridge-free, so an in-fiber caller (the loop's per-tick model call)
   *     composes it with `yield*` — the model call rides the SAME
   *     interceptor cascade, so its boundary hooks + guard fire (Phase 1B: this
   *     is the form the loop consumes; without it the loop's model call would
   *     get no hooks/guard).
   *   - **`stream`** — the JS `AsyncStream<Chunk, R>`: `for await` drains the
   *     chunks in order and `.result` resolves to the body's `R`. Both observe
   *     the same single run. Projected from `fx` via {@link runHarnessStream},
   *     threading the caller's `def.stream` streaming-edge policy.
   *   - **`run`** (inbox-addressable) — a remote/inbox caller of the declared
   *     verb gets the final `R`, not a stream: `run` drives the SAME operation
   *     with a no-op sink (chunks dropped) and returns the drained `R`. The
   *     boundary hooks + terminal fire once, identically to the other faces.
   *
   * **Abort.** `stream.abort(reason)` interrupts the operation fiber (the
   * kill/resume-critical path). Because `runOperation`'s settle step lets
   * interrupts pass through untouched, an aborted run publishes NO
   * `terminal:succeeded` and fires NO `onAfter` with a bogus value — `.result`
   * rejects with the interrupted cause.
   *
   * The signal-form rule ({@link command}) applies unchanged: a streaming
   * command carries verbs + serializable data only.
   */
  protected commandStream<I, Chunk, R, E>(def: {
    /** Canonical verb — must be prefixed `"${this.surface}:"`. */
    readonly name: string;
    /** Standard Schema for the payload; validated at inbox dispatch. */
    readonly input?: StandardSchemaV1<I>;
    /** Reachability (ADR 51 §2.3). Default `"addressable"`. */
    readonly exposure?: CommandExposure;
    readonly description?: string;
    /** Work-path scope dims (surface-specific — receives the input). */
    readonly scope?: (input: I) => EventScope;
    /** Deterministic opId derivation (ADR 51 idempotency). */
    readonly opId?: (input: I) => string;
    /**
     * Emits chunks via `sink`, returns the final result. Runs INSIDE the
     * operation cascade — guard/onBefore already applied to `input`, onAfter
     * applied to the returned `R`.
     */
    readonly body: (
      input: I,
      sink: (chunk: Chunk) => Effect.Effect<void>,
    ) => Effect.Effect<R, E, never>;
    /**
     * Declaration-time per-chunk interceptors (ADR 80 Phase 2) — the programmatic
     * twin of the minted `hooks.on<Verb>Chunk(...)` registrar. SINK-WRAP the
     * body's sink in list order; composed OUTERMOST of any dynamically-registered
     * interceptors (declared first = closest to the body). Each is an `observe`
     * tap or a buffering/coalescing `transform` (with optional flush-on-terminal).
     */
    readonly chunk?: readonly ChunkInterceptor<Chunk, RuntimeContext>[];
    /**
     * Streaming-edge policy for the `.stream` (AsyncStream) face ONLY — the
     * `.fx` sink-fold twin and the `.run` drain ignore it (they have no
     * Queue/iterator to police). Threads the {@link runHarnessStream} knobs a
     * concrete streaming command needs: `queueCapacity` (backpressure depth),
     * `isCancellation` (which body failures complete the iterator cleanly vs
     * throw — e.g. `model:generate_stream` maps `ProviderAborted`), and the
     * `onStart` / `onAbort` edge-bookkeeping hooks. Each hook is ALSO handed the
     * invocation `input`, so per-call state (the executor's `executionId`) is
     * reachable — `runHarnessStream`'s own hooks carry only the fiber/reason.
     */
    readonly stream?: {
      readonly queueCapacity?: number;
      readonly isCancellation?: (cause: unknown) => boolean;
      readonly onStart?: (fiber: Fiber.RuntimeFiber<R, unknown>, input: I) => void;
      readonly onAbort?: (reason: string, input: I) => void;
    };
  }): StreamCommand<I, Chunk, R, E> {
    return this.commandRunner.commandStream<I, Chunk, R, E>(def);
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
    return this.commandRunner.commands();
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
    const registered = this.commandRunner.get(msg.type);
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

  /**
   * One-way channel notification — the fire-and-forget twin of
   * {@link request}. Publishes the SAME `session:channel:<channel>`
   * envelope shape but registers NO Deferred and awaits no reply
   * (`metadata.requestType: "notify"`, no correlationId/replyTo). Use
   * when the far side runs/renders off the event but owes nothing back
   * (e.g. a client-handled tool with `requiresResponse` falsy).
   *
   * Never a control path: a bus-append failure is swallowed
   * (`E = never`) so a dropped notification cannot fail the caller's
   * operation. Callers `yield*` it inside an Effect body, or
   * `Effect.runFork` it.
   *
   * NOTE the name is `notifyChannel`, not a bare `notify`: ADR 47 ripped a
   * bespoke gateway `notify` transport surface, and a completeness test guards
   * that no `notify` resurfaces on a harness instance. This general channel-
   * notification primitive is a different concern (the message-bus twin of
   * {@link request}), so it carries the qualified name.
   */
  protected notifyChannel<TReq>(
    channel: string,
    payload: TReq,
    opts: { readonly scope?: EventScope } = {},
  ): Effect.Effect<void, never, never> {
    const scope: EventScope = opts.scope ?? {};
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
        requestType: "notify",
      },
    } as ProtocolEvent;
    return this.bus.append(envelope).pipe(Effect.catchAll(() => Effect.void));
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
    // ADR 83 §4 — detach from the interceptor parent so a torn-down child stops
    // receiving pushed registrations and is not retained by the parent's
    // children set. Fired before the substrate unwind (order-independent).
    if (this.detachFromInterceptorParent) {
      this.detachFromInterceptorParent();
      this.detachFromInterceptorParent = undefined;
    }
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
}

// Re-export InboxError type so concrete harnesses can type-narrow
// without pulling from @agentick/spec-next directly.
export type { InboxError };
