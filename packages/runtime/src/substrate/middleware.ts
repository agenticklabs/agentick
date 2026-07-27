/**
 * Middleware composition primitives (ADR 76/80/83) — the dedicated leaf home
 * for the interceptor COMPOSITION machinery, extracted from `base-harness.ts`
 * so both {@link BaseHarness} and `operation-runner.ts` import it without a
 * cycle (same discipline as `harness-protocol.ts` / `op-signals.ts`).
 *
 * This module owns the *primitives*, not the *state*: how a middleware list
 * composes around a body ({@link composeMiddleware} / {@link MiddlewareChain}),
 * how a pure-JS async middleware lifts onto the Effect channel while preserving
 * the fiber's world ({@link liftMiddleware}), how a declarative command-hook
 * config desugars to op-scoped middleware ({@link commandHookMiddleware} /
 * {@link hooksToMiddlewares} / {@link scopeToCommand}), and the tier-4
 * call-scoped FiberRef ({@link withCallMiddleware}). The STORAGE and
 * PROPAGATION of interceptor state — the LIVE construction-tree inheritance
 * (ADR 83 §4: `interceptorParent`, the descendant Set, push-on-register) —
 * stays on {@link BaseHarness}, which merely HOLDS {@link MiddlewareChain}
 * instances built here.
 *
 * @see docs/proposals/v2/blueprint/76-interceptor-tiers.md
 * @see docs/proposals/v2/blueprint/80-command-lifecycle-hooks.md
 * @see docs/proposals/v2/blueprint/83-interceptor-collapse.md
 */

import { Effect, Fiber, FiberRef, Runtime } from "effect";
import { unwrapExit } from "@agentick/utils";
import type {
  AfterHook,
  BeforeHook,
  ChunkHooksOf,
  ChunkRegistrarsOf,
  Derived,
  GuardDecision,
  GuardsOf,
  HandlerVerdict,
  HooksOf,
  Middleware,
  NamespaceGuardsOf,
  NamespaceHooksOf,
  Observability,
  OperationRunnerView,
  Ops,
  Pascal,
  RegistrarsOf,
  Unsubscribe,
  WireCommandMap,
} from "@agentick/spec";
import {
  createLog,
  parseHookKey,
  pascalOfCommand,
  qualifyNamespaceGuardKey,
  qualifyNamespaceHookKey,
} from "@agentick/spec";
import { getContext, type RuntimeContext } from "./runtime-context.js";
import { NOOP_METRICS, OFF_TRACE } from "./observability.js";
import { signalFromVerdict, tagInterceptor } from "./op-signals.js";

// ============================================================================
// InterceptorCtx — the facet-bearing ctx handed to every interceptor
// ============================================================================

/**
 * The ctx an {@link AsyncMiddleware} (a `.use` middleware, a `.guard`, or a
 * desugared command hook) receives as its third argument (ADR 64/78/19/83).
 * The operation's {@link RuntimeContext} (sessionId / opId / user …) LANDED
 * FLAT with the {@link Observability} facet (`ctx.log` / `ctx.trace` /
 * `ctx.metrics`) and the {@link Ops} facet (`ctx.run` / `ctx.runner`) — the
 * SAME surface a tool handler's `ctx` carries, so a gateway/app hook or guard
 * reaches diagnostics + the operation ladder with identical spelling.
 *
 * The facets are attached at the {@link liftMiddleware} boundary from a
 * per-op-built value the operation runner stashes on {@link InterceptorCtxRef}
 * (RuntimeContext itself stays pure DATA — no stored closures, per ADR 45).
 */
export type InterceptorCtx = RuntimeContext & Observability & Ops;

/**
 * FiberRef carrying the facet-decorated {@link InterceptorCtx} the operation
 * runner builds for an op's interceptor cascade (once per op, only when
 * interceptors are present). {@link liftMiddleware} reads it to hand each
 * middleware the facet-bearing ctx; `undefined` (no runner decorated the
 * scope — an isolated unit test) falls back to {@link detachedInterceptorCtx}.
 * Process-global by design, exactly like {@link CallMiddlewareRef} /
 * `RuntimeContextRef`.
 */
export const InterceptorCtxRef = FiberRef.unsafeMake<Derived<InterceptorCtx> | undefined>(
  undefined,
);

/** Detached `run` — throws: the operation ladder is unreachable without a runner. */
const detachedRun = (): never => {
  throw new Error("ctx.run is unavailable: middleware ran outside an operation runner");
};

/** Detached `runner` — same contract as {@link detachedRun}. */
const DETACHED_RUNNER: OperationRunnerView = {
  runOperation: () => {
    throw new Error("ctx.runner is unavailable: middleware ran outside an operation runner");
  },
};

/**
 * Off-path {@link InterceptorCtx} for a middleware that runs with no
 * runner-decorated scope (isolated unit tests). `log` is a no-op callable,
 * `trace`/`metrics` are the shared off singletons, `run`/`runner` throw — so
 * the TYPE stays honest and misuse fails loudly rather than silently.
 */
function detachedInterceptorCtx(rc: RuntimeContext): InterceptorCtx {
  return {
    ...rc,
    log: createLog(() => {}),
    trace: OFF_TRACE,
    metrics: NOOP_METRICS,
    run: detachedRun as Ops["run"],
    runner: DETACHED_RUNNER,
  };
}

// ============================================================================
// AsyncMiddleware — the pure-JS `harness.use` form
// ============================================================================

/**
 * Pure-JS middleware — the ergonomic `harness.use` form. `next(input)` returns
 * a Promise; `await` it to proceed, or return a value to short-circuit. No
 * Effect knowledge required.
 *
 * The third argument, **`ctx`**, is the operation's {@link InterceptorCtx} —
 * the {@link RuntimeContext} (sessionId / executionId / tickId / opId /
 * parentOpId / user …) LANDED FLAT with the {@link Observability} facet
 * (`ctx.log` / `ctx.trace` / `ctx.metrics`) and the {@link Ops} facet
 * (`ctx.run` / `ctx.runner`). Passed EXPLICITLY: an async middleware runs
 * OUTSIDE the fiber (see the caveat below), so it cannot read `getContext`
 * itself — `use`'s lift hands it the facet-decorated snapshot built at the op
 * boundary. An Effect middleware (`fx.use`) reads the same context natively via
 * `yield* getContext` (and the facets via {@link InterceptorCtxRef}).
 *
 * ```ts
 * harness.use(async (input, next, ctx) => {
 *   ctx.metrics.count("op.started", 1);
 *   const result = await ctx.trace("guarded-work", () => next(input));
 *   ctx.log.info({ op: ctx.op, sessionId: ctx.sessionId });
 *   return result;
 * });
 * ```
 *
 * **Honest caveat — only the middleware's OWN body is off-fiber.** `liftMiddleware`
 * forks each continuation on the AMBIENT runtime (`Effect.runtime()` — the
 * fiber's Context, FiberRefs, and tracer), so everything `next` *wraps* keeps
 * full in-fiber semantics across the `await`: OTel span-nesting, `RuntimeContext`
 * / `parentOpId`, tier-4 `withCallMiddleware`, and interruption (aborting a
 * `send` tears down the inner call — no leaked root). The ONE thing that stays
 * off-fiber is this function's own JS body (the statements around `await next`,
 * driven by the microtask queue) — it can't be fiber-interrupted mid-statement
 * and can't read `getContext`, which is why `ctx` is passed explicitly. For a
 * middleware whose own logic must be in-fiber, use `harness.fx.use` (the
 * Effect-native {@link Middleware}).
 */
export type AsyncMiddleware<I = unknown, R = unknown> = (
  input: I,
  next: (input: I) => Promise<R>,
  ctx: InterceptorCtx,
) => Promise<R>;

// ============================================================================
// Command lifecycle hooks (ADR 80) — the typed CommandRegistry → CommandHooks
// derivation. Co-located with AsyncMiddleware because a hook DESUGARS to an
// AsyncMiddleware entry (§7 fiber invariant) and carries the RuntimeContext —
// so, like AsyncMiddleware, it can't live in spec without a wrong-direction dep.
// ============================================================================

// `BeforeHook<In, Ctx>` / `AfterHook<Out, Ctx>` are defined in
// `@agentick/spec` (pure, context-parametric). The server binds
// `Ctx = RuntimeContext` at each derivation site below.

/**
 * The single source of truth mapping a command id to its `{ input; output }`
 * (ADR 80 §5); {@link CommandHooks} falls out mechanically. Two population
 * paths, both zero-per-hook-wiring:
 *
 *   - **Domain ops** — each harness package augments this via module
 *     augmentation of `@agentick/runtime` with one line per exposed verb
 *     (`"tool:dispatch"`, `"gateway:start"`, …), keyed `"<who>:<what>"`.
 *   - **Wire ops** — the gateway's `wire:<method>` dispatch boundary ops are
 *     folded in WHOLESALE by extending {@link WireCommandMap} (ADR 83
 *     §"Wire dispatch through the seam"). Every `WireMethods` row — framework or
 *     adopter-augmented — thus mints a typed `onBeforeWire<...>` /
 *     `onAfterWire<...>` gateway hook with NO extra declaration. The extends is
 *     legal because `WireCommandMap`'s keys are statically known, and it
 *     re-derives lazily when an adopter augments `WireMethods`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CommandRegistry extends WireCommandMap {}

/**
 * The bare `on<Command>` full-middleware key half of {@link CommandHooks}
 * (ADR 83 amendment) — the whole `(input, next, ctx) => output` wrapper (wrap /
 * retry / short-circuit / try-finally / shared state across both faces), typed
 * to the command, unlike raw `.use` (untyped, global). before/after are
 * one-sided sugar on top. AsyncMiddleware-valued, so it stays runtime-owned
 * (distinct from the spec-owned {@link HooksOf} before/after halves).
 */
type CommandAroundHooks = {
  [K in keyof CommandRegistry as `on${Pascal<K & string>}`]?: AsyncMiddleware<
    CommandRegistry[K] extends { input: infer I } ? I : never,
    CommandRegistry[K] extends { output: infer O } ? O : never
  >;
};

/**
 * The derived, never-hand-written hook surface (ADR 80 §5): each
 * {@link CommandRegistry} entry mints `onBefore<Pascal>?` (over its input) and
 * `onAfter<Pascal>?` (over its output) via the spec-owned {@link HooksOf}
 * generic (bound to `RuntimeContext`), plus the bare `on<Command>?`
 * full-middleware key ({@link CommandAroundHooks}). The type-level `Pascal` is
 * the exact twin of the runtime `deriveHookNames` — they MUST agree (a test).
 */
export type CommandHooks = HooksOf<CommandRegistry, InterceptorCtx> &
  CommandAroundHooks &
  ChunkHooksOf<CommandRegistry, InterceptorCtx>;

/**
 * The per-verb IMPERATIVE full-middleware registrar surface (ADR 83 amendment)
 * — the `on<Command>` primitive as `(mw) => Unsubscribe` methods. Mirrors
 * {@link HookRegistrars}'s before/after halves but valued with the whole
 * {@link AsyncMiddleware} typed to the command's input/output. Folded into
 * {@link HookRegistrars} so `harness.hooks.on<Command>(mw)` is typed.
 */
export type CommandMiddlewares = {
  [K in keyof CommandRegistry as `on${Pascal<K & string>}`]: (
    mw: AsyncMiddleware<
      CommandRegistry[K] extends { input: infer I } ? I : never,
      CommandRegistry[K] extends { output: infer O } ? O : never
    >,
  ) => Unsubscribe;
};

/**
 * The per-verb IMPERATIVE registrar surface — the same `Pascal<K>` derivation
 * as {@link CommandHooks}, valued as `(fn) => Unsubscribe` methods. Reached via
 * `harness.hooks` (a Proxy): `harness.hooks.onBeforeToolDispatch(fn)` registers
 * a hook dynamically and returns its remover. Only augmented verbs are callable
 * keys.
 */
export type HookRegistrars = RegistrarsOf<CommandRegistry, InterceptorCtx> &
  CommandMiddlewares &
  ChunkRegistrarsOf<CommandRegistry, InterceptorCtx>;

// ============================================================================
// Command guards (ADR 93) — the verdict bag, sibling of CommandHooks
// ============================================================================

/**
 * The derived DECLARATIVE guard surface (ADR 93) — the `guards:` bag at the app
 * / gateway / session level, keyed by the DISCRIMINATED command
 * (`{ timelineAppend, toolDispatch }`) and valued with a decider returning a
 * {@link HandlerVerdict}. The sibling of {@link CommandHooks}: guards are a
 * distinct KIND (verdict seam), never folded into hooks, and the operation
 * runner floats every guard OUTERMOST so an app guard vetoes before any
 * transform — or any narrower guard — runs.
 */
export type CommandGuards = GuardsOf<CommandRegistry, InterceptorCtx>;

/**
 * The DROP-LAYER guard bag for ONE namespace (ADR 93) — what a
 * `defineX({ guards })` accepts: the same commands keyed by their bare verb
 * (`{ append }` on a timeline definition) instead of the discriminated name.
 * Desugars onto the identical op-scoped guard interceptor.
 */
export type NamespaceGuards<NS extends string> = NamespaceGuardsOf<
  CommandRegistry,
  NS,
  InterceptorCtx
>;

/**
 * The DROP-LAYER hook bag for ONE namespace (ADR 93) — what a
 * `defineX({ hooks })` accepts: `onBeforeAppend` rather than
 * `onBeforeTimelineAppend`. Desugars onto the identical op-scoped `transform`
 * interceptor via {@link namespaceHooksToMiddlewares}.
 */
export type NamespaceHooks<NS extends string> = NamespaceHooksOf<
  CommandRegistry,
  NS,
  InterceptorCtx
>;

/**
 * Build ONE op-scoped `guard`-kind interceptor from a decider (ADR 93) — the
 * shared core of `BaseHarness.guard({...})` (own chain) and
 * {@link guardsToMiddlewares} (the declarative app/gateway config fold).
 *
 * `command` is the command's Pascal suffix (`"TimelineAppend"`) — the value
 * `runOperation` stamps on `ctx.op` — so the guard self-scopes to one verb on
 * the shared chain, exactly as a command hook does. A verdict other than
 * `proceed` is raised as the control-signal `runOperation` maps to its terminal
 * (`vetoed` / `replaced` / `deferred`); because guards compose outermost, no
 * transform can swallow it.
 */
export function commandGuardMiddleware(
  command: string,
  decide: GuardDecision<unknown, unknown, InterceptorCtx>,
): Middleware<unknown, unknown, unknown> {
  const mw: AsyncMiddleware<unknown, unknown> = async (input, next, ctx) => {
    const verdict = (await decide(input, ctx)) ?? ({ kind: "proceed" } as const);
    if (verdict.kind === "proceed") return next(input);
    // `liftMiddleware` runs this body on the Effect channel; a throw becomes the
    // op's typed failure, which is exactly how the signal must travel.
    throw signalFromVerdict(verdict as HandlerVerdict<unknown>);
  };
  return tagInterceptor("guard", liftMiddleware(scopeToCommand(command, mw))) as Middleware<
    unknown,
    unknown,
    unknown
  >;
}

/**
 * Adapt a declarative {@link CommandGuards} config into op-scoped `guard`-kind
 * middlewares (ADR 93) — the guard twin of {@link hooksToMiddlewares}, used by
 * the app/gateway config fold so `createApp({ guards })` rides the SAME
 * `inheritedInterceptors` cascade that carries hooks and `.use` transforms.
 * Keys are the discriminated command in camelCase (`timelineAppend`).
 */
export function guardsToMiddlewares(
  config: CommandGuards,
): Middleware<unknown, unknown, unknown>[] {
  const out: Middleware<unknown, unknown, unknown>[] = [];
  for (const [key, fn] of Object.entries(config as Record<string, unknown>)) {
    if (fn === undefined) continue;
    out.push(
      commandGuardMiddleware(
        pascalOfCommand(key),
        fn as GuardDecision<unknown, unknown, InterceptorCtx>,
      ),
    );
  }
  return out;
}

/**
 * Requalify a namespace's DROP-LAYER `hooks:` bag onto the discriminated
 * {@link CommandHooks} shape (ADR 93) — `{ onBeforeAppend }` on a `"timeline"`
 * definition becomes `{ onBeforeTimelineAppend }`, which then desugars through
 * the ordinary hook path. Keys that are not hook keys are dropped (defensive).
 */
export function qualifyNamespaceHooks(
  namespace: string,
  bag: Readonly<Record<string, unknown>>,
): CommandHooks {
  const out: Record<string, unknown> = {};
  for (const [key, fn] of Object.entries(bag)) {
    if (fn === undefined) continue;
    const qualified = qualifyNamespaceHookKey(namespace, key);
    if (qualified !== undefined) out[qualified] = fn;
  }
  return out as CommandHooks;
}

/**
 * Requalify a namespace's DROP-LAYER `guards:` bag onto the discriminated
 * {@link CommandGuards} shape (ADR 93) — `{ append }` on a `"timeline"`
 * definition becomes `{ timelineAppend }`, which then desugars through the
 * ordinary guard path onto `ctx.op === "TimelineAppend"`: the same op an
 * app-level `guards: { timelineAppend }` reaches.
 */
export function qualifyNamespaceGuards(
  namespace: string,
  bag: Readonly<Record<string, unknown>>,
): CommandGuards {
  const out: Record<string, unknown> = {};
  for (const [verb, fn] of Object.entries(bag)) {
    if (fn === undefined) continue;
    out[uncapitalize(qualifyNamespaceGuardKey(namespace, verb))] = fn;
  }
  return out as CommandGuards;
}

/** Lowercase the first char — the runtime twin of the type-level `Uncap`. */
function uncapitalize(s: string): string {
  return s === "" ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

// ============================================================================
// Composition + lifting
// ============================================================================
//
// NOTE (ADR 83): `HandlerRegistry` + `mergeVerdict` are GONE. The verdict guard
// collapsed into the universal interceptor seam — a guard is a `guard`-kind
// `Middleware` that raises an OperationSignal (see op-signals.ts). The
// verdict-merge PRIORITY (veto > replace > defer, order-independent) is
// replaced by compose-order: the outermost guard decides first.

/**
 * Compose an explicit middleware list around a body. First element is
 * outermost. Shared by {@link MiddlewareChain.compose} and (ADR 76) by the
 * operation runner when it composes an assembled stack (tier 4 + inherited +
 * own).
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

// ============================================================================
// Span annotation helpers (telemetry rung 3) — ADR 78/83
// ============================================================================
//
// Every operation already runs INSIDE an OTel span (`runOperation` wraps the
// body via `Effect.withSpan`, ADR 78). These helpers are ENRICHMENT — they add
// attributes to that ambient span (or, for `spanMiddleware(name)`, open a named
// child under it). They compose into the ONE interceptor cascade (ADR 83) like
// any other middleware; nothing here is a parallel telemetry subsystem.
//
// The attribute bag is an OPEN `Record<string, unknown>` at every seam — a new
// telemetry dimension NEVER requires a framework change, only a new key.

/**
 * An open bag of span attributes. Deliberately `Record<string, unknown>` (not a
 * closed shape) so adopters stamp any dimension without a framework change.
 */
export type SpanAttributes = Readonly<Record<string, unknown>>;

/**
 * Annotate the CURRENT operation span (telemetry rung 3, the per-moment seam) —
 * the public free function twin of Effect's `annotateCurrentSpan`, reading the
 * fiber's active span. Call it anywhere IN-FIBER: inside a command body, a
 * `guard`/`use` interceptor, or a lifecycle hook that runs on the Effect
 * channel. Attributes computed mid-execution (a retry count, a cache-hit flag,
 * a token total known only after the provider replies) belong here — the value
 * is known at THIS moment, not at registration.
 *
 * ```ts
 * // inside a command body / Effect-native interceptor
 * yield* annotateOperationSpan({ "acme.cache_hit": hit });
 * ```
 *
 * A no-op when no span is active (no tracer wired) — never throws. Composition
 * primitive under {@link spanAttributes} / {@link spanMiddleware}.
 */
export function annotateOperationSpan(attributes: SpanAttributes): Effect.Effect<void> {
  return Effect.annotateCurrentSpan(attributes as Record<string, unknown>);
}

/**
 * A `Middleware` that annotates the ambient operation span with attributes
 * derived from the op's input + {@link RuntimeContext} (telemetry rung 3, the
 * per-op-type seam). Register it via `harness.fx.use(...)` or a decorated hook
 * (`harness.hooks.on<Command>(...)` where an Effect-native middleware is
 * accepted), or fold it into a tier-4 `withCallMiddleware` list. Returns an
 * {@link Unsubscribe} through the register — dynamic tracing is a lease.
 *
 * Use when the attributes are STATIC PER COMMAND KIND but depend on the call's
 * input — `model.id` off `input.target`, `tool.name` off a dispatch input.
 * `attrs` runs BEFORE the body; for attributes derived from the RESULT, use an
 * Effect-native middleware that reads `next(input)`'s value then calls
 * {@link annotateOperationSpan}.
 *
 * ```ts
 * harness.fx.use(spanAttributes((input) => ({ "acme.model_id": input.target.modelId })));
 * ```
 */
export function spanAttributes<I = unknown, R = unknown>(
  attrs: (input: I, ctx: RuntimeContext) => SpanAttributes,
): Middleware<I, R, unknown> {
  return (input, next) =>
    Effect.gen(function* () {
      const ctx = yield* getContext;
      yield* annotateOperationSpan(attrs(input, ctx));
      return yield* next(input);
    });
}

/**
 * A `Middleware` that either annotates the ambient op span (when `name` is
 * omitted — behaves like {@link spanAttributes}) OR opens a NAMED CHILD span
 * nested under it (when `name` is given). The named-child form is an explicit
 * adopter capability for carving a sub-operation out of a command body's work;
 * the framework's own enrichment never names a span (every op is already
 * spanned — ADR 78). `attrs` (optional) supplies the child/annotation
 * attributes from the op input + {@link RuntimeContext}.
 *
 * ```ts
 * const stop = harness.fx.use(spanMiddleware("acme.retrieval", (input) => ({ "acme.query": input.q })));
 * stop(); // lease released — dynamic tracing off
 * ```
 */
export function spanMiddleware<I = unknown, R = unknown>(
  name?: string,
  attrs?: (input: I, ctx: RuntimeContext) => SpanAttributes,
): Middleware<I, R, unknown> {
  return (input, next) =>
    Effect.gen(function* () {
      const ctx = yield* getContext;
      const attributes = (attrs ? attrs(input, ctx) : {}) as Record<string, unknown>;
      if (name !== undefined) {
        return yield* next(input).pipe(Effect.withSpan(name, { attributes }));
      }
      yield* annotateOperationSpan(attributes);
      return yield* next(input);
    });
}

/**
 * Lift an {@link AsyncMiddleware} (pure JS) into the Effect-native
 * {@link Middleware} the chain composes. The lifted middleware runs the inner
 * `next` on a **forked child fiber of the ambient runtime** so the adopter can
 * `await` its result.
 *
 * **The fork inherits the fiber's world.** We capture `Effect.runtime()` — the
 * ambient Runtime, which bundles the fiber's Context (the current OTel span,
 * services), its FiberRefs (`RuntimeContext`, the tier-4 `CallMiddlewareRef`),
 * AND the tracer — then fork the continuation on THAT runtime
 * (`Runtime.runFork(runtime)`), not the default one. A naive `Effect.runFork`
 * would seed a bare root on the DEFAULT runtime: no tracer, empty FiberRefs, no
 * parent span. Because we fork on the captured runtime instead, **span-nesting,
 * `parentOpId`, and call-scoped (tier-4) middleware all survive the async
 * boundary** — a span opened inside the wrapped ops nests under the op's span.
 *
 * **Interruption IS re-threaded.** `Effect.tryPromise` exposes an `AbortSignal`
 * that fires when the OUTER op fiber is interrupted; we hold each continuation's
 * fiber handle and interrupt it on that signal. So aborting a `send` tears down
 * the in-flight inner model/tool call rather than leaking a detached root.
 *
 * The ONE thing that stays out-of-fiber is the async middleware's OWN body (the
 * JS statements around `await next` — a JS async fn is driven by the microtask
 * queue, not a fiber, and its suspension points aren't externally steppable).
 * That is inherent, and why `ctx` is passed explicitly. A rejection (from
 * `next`, or thrown by the async middleware) surfaces on the `E` channel
 * unchanged.
 *
 * `use()` / `withCallMiddleware` call this automatically for `async` functions;
 * use it explicitly for a promise-returning middleware NOT declared `async`.
 */
export function liftMiddleware<I = unknown, R = unknown, E = unknown>(
  mw: AsyncMiddleware<I, R>,
): Middleware<I, R, E> {
  return (input, next) =>
    Effect.gen(function* () {
      // The explicit `ctx` arg: the facet-decorated InterceptorCtx the runner
      // built for this op (log/trace/metrics/run/runner landed flat on the
      // RuntimeContext). Absent only when a middleware runs outside a runner
      // (isolated unit test) — the detached off-path ctx keeps the type honest.
      const decorated = yield* FiberRef.get(InterceptorCtxRef);
      const ctx: InterceptorCtx = decorated ?? detachedInterceptorCtx(yield* getContext);
      // Capture the whole ambient runtime — Context (parent span, services) +
      // FiberRefs + tracer — so forking on it below inherits the fiber's world
      // across the boundary.
      const runtime = yield* Effect.runtime<never>();
      const forkOnRuntime = Runtime.runFork(runtime);
      return yield* Effect.tryPromise({
        // `signal` fires when the outer op fiber is interrupted. Fork each
        // continuation so we can interrupt it on abort — a plain `runPromise`
        // would leave the inner call running detached after an aborted send.
        try: (signal) => {
          const nextPromise = (i: I): Promise<R> => {
            const fiber = forkOnRuntime(next(i) as Effect.Effect<R, never, never>);
            const onAbort = (): void => {
              forkOnRuntime(Fiber.interrupt(fiber));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
            return Runtime.runPromise(runtime)(Fiber.await(fiber))
              .then((exit) => unwrapExit(exit) as R)
              .finally(() => signal.removeEventListener("abort", onAbort));
          };
          // Hand the async middleware the captured `ctx` explicitly — it runs
          // outside the fiber and can't read `getContext` itself.
          return mw(input, nextPromise, ctx);
        },
        catch: (e) => e as E,
      });
    });
}

/**
 * Adapt a {@link BeforeHook} into an {@link AsyncMiddleware}: await the hook,
 * thread its reshaped input (or the original on `void`) into `next`; a `throw`
 * propagates as a veto. Lifted through the SAME `liftMiddleware` path `.use`
 * uses — the ADR 80 §7 fiber invariant.
 */
const asBefore =
  <I, R>(hook: BeforeHook<I>): AsyncMiddleware<I, R> =>
  async (input, next, ctx) =>
    next(((await hook(input, ctx)) ?? input) as I);

/** Adapt an {@link AfterHook} into an {@link AsyncMiddleware} (symmetric to {@link asBefore}). */
const asAfter =
  <I, R>(hook: AfterHook<R>): AsyncMiddleware<I, R> =>
  async (input, next, ctx) => {
    const out = await next(input);
    return ((await hook(out, ctx)) ?? out) as R;
  };

/**
 * Self-scope an {@link AsyncMiddleware} to a single command on the shared `.use`
 * chain (ADR 83 amendment). The lifted middleware composes on EVERY op; this
 * wrapper compares the op's `ctx.op` (the command suffix `runOperation` stamps)
 * to `command` and delegates to `mw` only on a match, otherwise passes straight
 * through to `next`. This is the per-middleware `ctx` compare that replaced the
 * old keyed `Hooks` map — one chain, one cascade, op-scoping by tag + compare.
 */
export const scopeToCommand =
  <I, R>(command: string, mw: AsyncMiddleware<I, R>): AsyncMiddleware<I, R> =>
  (input, next, ctx) =>
    ctx.op === command ? mw(input, next, ctx) : next(input);

/**
 * The Effect-native `guard`/`transform`/`observe` middleware for ONE command
 * hook config entry — the shared core of `BaseHarness.hook` (own, dynamic) and
 * {@link hooksToMiddlewares} (the declarative session-config fold).
 * `before`/`after` keys desugar via {@link asBefore}/{@link asAfter}; a bare
 * `on<Command>` key IS already an {@link AsyncMiddleware} (used as-is). The
 * result is op-scoped via {@link scopeToCommand}, lifted through the SAME
 * {@link liftMiddleware} fiber path `.use` uses, and tagged `transform`.
 * Returns `undefined` for a non-hook key (defensive).
 */
export function commandHookMiddleware(
  key: string,
  fn: unknown,
): Middleware<unknown, unknown, unknown> | undefined {
  const parsed = parseHookKey(key);
  if (parsed === undefined) return undefined;
  // Chunk interceptors (ADR 80 Phase 2) SINK-WRAP the streaming body; they are
  // NOT op-scoped middleware, so they never join the interceptor cascade. Skip
  // them here — the CommandRunner's `registerChunkInterceptor` owns their path.
  if (parsed.kind === "chunk") return undefined;
  const wrapped: AsyncMiddleware<unknown, unknown> =
    parsed.kind === "before"
      ? asBefore(fn as BeforeHook<unknown>)
      : parsed.kind === "after"
        ? asAfter(fn as AfterHook<unknown>)
        : (fn as AsyncMiddleware<unknown, unknown>);
  return tagInterceptor(
    "transform",
    liftMiddleware(scopeToCommand(parsed.command, wrapped)),
  ) as Middleware<unknown, unknown, unknown>;
}

/**
 * Adapt a declarative {@link CommandHooks} config into op-scoped `transform`
 * middlewares (ADR 83 amendment) — the pure function the app/session config
 * fold uses to thread declarative hooks through the SAME `inheritedInterceptors`
 * cascade that carries guards + `.use` middleware. Each entry rides
 * {@link commandHookMiddleware}: before/after desugar, `on<Command>` passes
 * through, all self-scope by `ctx.op`. `[]` for an empty config.
 */
export function hooksToMiddlewares(config: CommandHooks): Middleware<unknown, unknown, unknown>[] {
  const out: Middleware<unknown, unknown, unknown>[] = [];
  for (const [key, fn] of Object.entries(config as Record<string, unknown>)) {
    if (fn === undefined) continue;
    const mw = commandHookMiddleware(key, fn);
    if (mw !== undefined) out.push(mw);
  }
  return out;
}

// ============================================================================
// MiddlewareChain — a single tier's registered list (outer→inner)
// ============================================================================

export class MiddlewareChain {
  private middlewares: Middleware<unknown, unknown, unknown>[] = [];

  use<I, R, E = unknown>(mw: Middleware<I, R, E>): Unsubscribe {
    this.middlewares.push(mw as Middleware<unknown, unknown, unknown>);
    return () => this.remove(mw as Middleware<unknown, unknown, unknown>);
  }

  /**
   * Remove a middleware by identity (first occurrence). The removal seam
   * ADR 83 §4 live inheritance uses to cascade an unsubscribe into a
   * descendant's inherited layer — where the pushing parent didn't hold that
   * descendant's `use()` closure (a descendant constructed AFTER the
   * registration pulled the interceptor via the fold). No-op when absent.
   */
  remove(mw: Middleware<unknown, unknown, unknown>): void {
    const idx = this.middlewares.indexOf(mw);
    if (idx >= 0) this.middlewares.splice(idx, 1);
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
 * call `session.send → loop → executor → tool` is ONE fiber, so this FiberRef
 * reaches every nested `runOperation` in every harness the call touches — *even
 * across construction-siblings* (the app builds the loop / executor / tool as
 * shared singletons; they are not construction-children of the session, so a
 * session-scoped concern around the model call CANNOT be expressed structurally
 * — only here, dynamically).
 *
 * Process-global by design (one FiberRef for the whole runtime, exactly like
 * `RuntimeContextRef`) — so it lives at module scope, not per-instance.
 */
const CallMiddlewareRef = FiberRef.unsafeMake<readonly Middleware<unknown, unknown, unknown>[]>([]);

/** Read the ambient call-scoped middleware list. Substrate-internal — the operation runner composes it outermost per op. */
export const getCallMiddleware: Effect.Effect<readonly Middleware<unknown, unknown, unknown>[]> =
  FiberRef.get(CallMiddlewareRef);

/**
 * Scope `middleware` around `effect` for the current dynamic call tree
 * (ADR 76 tier 4). Every nested `runOperation` the effect transitively reaches
 * — in ANY harness, across construction-siblings — composes it **outermost**
 * (broadest scope); when `effect` settles it evaporates. Nested
 * `withCallMiddleware` calls ACCUMULATE (append, so an outer provider stays
 * outermost). Empty list is a pass-through.
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
