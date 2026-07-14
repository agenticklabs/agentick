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
 *                    inherited via the construction-fold (`inheritedInterceptors`)
 *   ④ Events       — `emit` (light path) + `emitDelta` (in-flight)
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

import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberRef,
  ManagedRuntime,
  Option,
  Queue,
  Runtime,
} from "effect";
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
  MessageHandlerError,
  registerAgentickError,
} from "@agentick/spec-next";
import { resolveSyncSubstrateSlot } from "./resolve-slot.js";
import { ulid } from "./ulid.js";
import { getContext, type RuntimeContext, withContext } from "./runtime-context.js";
import { RequestResponseRegistry, type RequestError } from "./request-response-registry.js";
import {
  type InterceptorKind,
  type OperationReplace,
  type OperationSignal,
  interceptorKind,
  isOperationSignal,
  orderInterceptors,
  signalFromVerdict,
  tagInterceptor,
} from "./op-signals.js";

export {
  OperationVeto,
  OperationDefer,
  OperationReplace,
  isOperationSignal,
  interceptorKind,
  orderInterceptors,
  type InterceptorKind,
  type OperationSignal,
} from "./op-signals.js";

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
  ctx: RuntimeContext,
) => Promise<R>;

// ============================================================================
// Command lifecycle hooks (ADR 80) — the typed CommandRegistry → CommandHooks
// derivation. Co-located with AsyncMiddleware because a hook DESUGARS to an
// AsyncMiddleware entry (§7 fiber invariant) and carries the RuntimeContext —
// so, like AsyncMiddleware, it can't live in spec without a wrong-direction dep.
// ============================================================================

/**
 * A before-hook (ADR 80 §4): receives the command's input plus the op's
 * {@link RuntimeContext}. Return the reshaped input to **transform**, `void`
 * to **observe/passthrough**, or `throw` to **veto** (the op aborts with the
 * thrown error on the `E` channel — no verdict DSL).
 */
export type BeforeHook<In, Ctx = RuntimeContext> = (
  input: In,
  ctx: Ctx,
) => In | void | Promise<In | void>;

/** An after-hook — symmetric to {@link BeforeHook} over the command's output. */
export type AfterHook<Out, Ctx = RuntimeContext> = (
  output: Out,
  ctx: Ctx,
) => Out | void | Promise<Out | void>;

/**
 * Empty-seed registry (ADR 80 §5) — the single source of truth mapping a
 * command id (`"<who>:<what>"`) to its `{ input; output }`. Each harness
 * package augments it with one line per exposed verb via module augmentation
 * of `@agentick/runtime-next`; {@link CommandHooks} falls out mechanically.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CommandRegistry {}

/** Uppercase the first char of `S`, leaving the tail untouched. */
type Cap<S extends string> = S extends `${infer H}${infer T}` ? `${Uppercase<H>}${T}` : S;
/** PascalCase a command id, splitting on the `:` (command) and `/` (wire) delimiters. */
type Pascal<S extends string> = S extends `${infer A}:${infer B}`
  ? `${Cap<A>}${Pascal<B>}`
  : S extends `${infer A}/${infer B}`
    ? `${Cap<A>}${Pascal<B>}`
    : Cap<S>;

/**
 * The derived, never-hand-written hook surface (ADR 80 §5): each
 * {@link CommandRegistry} entry mints `onBefore<Pascal>?` (over its input) and
 * `onAfter<Pascal>?` (over its output). The type-level `Pascal` is the exact
 * twin of the runtime {@link deriveHookNames} — they MUST agree (a test).
 */
export type CommandHooks = {
  [K in keyof CommandRegistry as `onBefore${Pascal<K & string>}`]?: BeforeHook<
    CommandRegistry[K] extends { input: infer I } ? I : never
  >;
} & {
  [K in keyof CommandRegistry as `onAfter${Pascal<K & string>}`]?: AfterHook<
    CommandRegistry[K] extends { output: infer O } ? O : never
  >;
};

// ============================================================================
// MiddlewareChain — outer→inner composition
// ============================================================================
//
// NOTE (ADR 83): `HandlerRegistry` + `mergeVerdict` are GONE.
// The verdict guard collapsed into the universal interceptor seam — a guard is a
// `guard`-kind `Middleware` that raises an OperationSignal (see op-signals.ts).
// The verdict-merge PRIORITY (veto > replace > defer, order-independent) is
// replaced by compose-order: the outermost guard decides first. See STATUS note.

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
      // Capture the ambient context (for the explicit `ctx` arg) AND the whole
      // ambient runtime — Context (parent span, services) + FiberRefs + tracer —
      // so forking on it below inherits the fiber's world across the boundary.
      const ctx = yield* getContext;
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
 * Resolve a command's op name (`"<surface>:command:<verb>"`) to its
 * `[onBefore…, onAfter…]` hook names (ADR 80 §5). Strips the `:command:`
 * infix to the canonical `"<who>:<what>"`, then PascalCases (splitting on `:`
 * AND `/`). The runtime twin of the type-level `Pascal` — they MUST agree, so
 * `deriveHookNames("tool:command:dispatch")` === `["onBeforeToolDispatch",
 * "onAfterToolDispatch"]`, the names `CommandHooks` mints for `"tool:dispatch"`.
 */
export function deriveHookNames(opName: string): [string, string] {
  const pascal = opName
    .replace(":command:", ":")
    .split(/[:/]/)
    .map((seg) => (seg === "" ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join("");
  return [`onBefore${pascal}`, `onAfter${pascal}`];
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
 * Parse a {@link CommandHooks} key into its `{ kind, command }` — the single
 * strip both {@link Hooks.from} (over config keys) and {@link Hooks.forOp} (over
 * {@link deriveHookNames} output) route through, so they key `byCommand` by the
 * IDENTICAL Pascal command suffix. `deriveHookNames` mints `onBefore${Pascal}` /
 * `onAfter${Pascal}`; config keys ARE `onBefore${Pascal}` / `onAfter${Pascal}`
 * (type-guaranteed) — stripping the prefix from either yields the same key, which
 * is why `from`/`forOp` provably agree (a test). Returns `undefined` for a
 * non-hook key (defensive; `CommandHooks` admits only hook keys).
 */
function parseHookKey(key: string): { kind: "before" | "after"; command: string } | undefined {
  if (key.startsWith("onBefore")) return { kind: "before", command: key.slice("onBefore".length) };
  if (key.startsWith("onAfter")) return { kind: "after", command: key.slice("onAfter".length) };
  return undefined;
}

/**
 * An immutable, per-command layer of {@link CommandHooks} (ADR 82).
 *
 * Holds LISTS per command so layers **compose** — two layers both setting
 * `onBeforeToolDispatch` can't share a flat object key, hence the class. The
 * construction cascade (gateway → app → session → sub-harness) folds down the
 * scope chain ONCE at construction via {@link extend}: `resolved =
 * parentResolved.extend(ownHooks)`. Every op then reads its local, fully-resolved
 * `Hooks` through {@link forOp} — the fold IS the walk, memoized at each node.
 * This replaces ADR 80's per-op `ownAndInheritedHooks` parent-walk.
 *
 * `byCommand` is keyed by the Pascal command suffix (`"ToolProbe"`), the shared
 * output of {@link parseHookKey} over both config keys and `deriveHookNames`.
 *
 * @see docs/proposals/v2/blueprint/82-hooks-cascade-as-construction-fold.md
 */
export class Hooks {
  private constructor(
    private readonly byCommand: ReadonlyMap<
      string,
      { readonly before: BeforeHook<unknown>[]; readonly after: AfterHook<unknown>[] }
    >,
  ) {}

  /** The identity element of {@link extend}: contributes no hooks. */
  static readonly empty = new Hooks(new Map());

  /**
   * Index a declarative {@link CommandHooks} object into per-command
   * before/after lists — the reverse of {@link deriveHookNames}: each
   * `onBefore<Pascal>` / `onAfter<Pascal>` key maps to
   * `byCommand[<Pascal>].{before,after}` via {@link parseHookKey}.
   */
  static from(config: CommandHooks): Hooks {
    const byCommand = new Map<
      string,
      { before: BeforeHook<unknown>[]; after: AfterHook<unknown>[] }
    >();
    for (const [key, fn] of Object.entries(config as Record<string, unknown>)) {
      if (fn === undefined) continue;
      const parsed = parseHookKey(key);
      if (parsed === undefined) continue;
      let slot = byCommand.get(parsed.command);
      if (slot === undefined) {
        slot = { before: [], after: [] };
        byCommand.set(parsed.command, slot);
      }
      if (parsed.kind === "before") slot.before.push(fn as BeforeHook<unknown>);
      else slot.after.push(fn as AfterHook<unknown>);
    }
    return byCommand.size === 0 ? Hooks.empty : new Hooks(byCommand);
  }

  /**
   * COMPOSE, not override: append `child`'s lists AFTER this layer's, per command
   * (outer-first — this layer is the ancestor, so its before-hooks see the input
   * first and its after-hooks transform the output last). Immutable — returns a
   * new `Hooks`. This is the ONE place hooks diverge from tools (last-wins
   * override); an ancestor AND a descendant hook on the same command both fire.
   */
  extend(child: Hooks): Hooks {
    if (child.byCommand.size === 0) return this;
    if (this.byCommand.size === 0) return child;
    const merged = new Map<
      string,
      { before: BeforeHook<unknown>[]; after: AfterHook<unknown>[] }
    >();
    for (const [command, slot] of this.byCommand) {
      merged.set(command, { before: [...slot.before], after: [...slot.after] });
    }
    for (const [command, slot] of child.byCommand) {
      const existing = merged.get(command);
      if (existing === undefined) {
        merged.set(command, { before: [...slot.before], after: [...slot.after] });
      } else {
        existing.before.push(...slot.before);
        existing.after.push(...slot.after);
      }
    }
    return new Hooks(merged);
  }

  /**
   * The composed middleware entries for one op — already cascade-resolved,
   * lifted through the SAME {@link liftMiddleware} path `.use` uses (the ADR 80
   * §7 fiber invariant, unchanged). Before-hooks precede after-hooks; both fire
   * in list (outer-first) order. `[]` for an unhooked op — a byte-identical
   * composed chain to the no-hooks case.
   */
  forOp(opName: string): Middleware<unknown, unknown, unknown>[] {
    const [beforeName] = deriveHookNames(opName);
    const parsed = parseHookKey(beforeName);
    if (parsed === undefined) return [];
    const slot = this.byCommand.get(parsed.command);
    if (slot === undefined) return [];
    return [
      ...slot.before.map((h) => liftMiddleware(asBefore(h))),
      ...slot.after.map((h) => liftMiddleware(asAfter(h))),
    ];
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
   * Command lifecycle hooks (ADR 82) — the RESOLVED per-command {@link Hooks}
   * value, already cascade-folded down the construction scope chain by the
   * caller (`resolved = parentResolved.extend(Hooks.from(ownConfig))`). The
   * harness reads it locally per op via {@link Hooks.forOp}; each entry rides
   * the `liftMiddleware` fiber path verbatim (§7). Defaults to {@link Hooks.empty}.
   *
   * The declarative `CommandHooks` config is folded into this value by the scope
   * that owns the option (`createApp`/`createSession`) — not here.
   */
  readonly hooks?: Hooks;
  /**
   * The parent scope's resolved interceptor snapshot (ADR 76 tier 3), folded
   * in at construction — mirrors {@link hooks}. Guards + transforms both live
   * on `this.middleware` and inherit via this seam: the caller computes the
   * value once (`parent.resolvedInterceptors()`) and hands it down, so no op
   * ever walks a construction-parent chain. Composed OUTERMOST of this
   * harness's own middleware (broader scope first). Defaults to `[]`.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
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
   * The RESOLVED command lifecycle hooks (ADR 82) — a fully cascade-folded
   * {@link Hooks} value. Consulted per-op by {@link Hooks.forOp}, which lifts
   * each matching hook into the command's middleware chain. {@link Hooks.empty}
   * when none were supplied. The cascade lives in the FOLD (the caller's
   * `extend`), not a per-op parent-walk.
   * @see BaseHarnessOptions.hooks
   */
  protected readonly hooks: Hooks;
  /**
   * The parent scope's RESOLVED interceptor snapshot (ADR 76 tier 3), folded
   * in at construction — the middleware twin of {@link hooks}. The cascade
   * lives in the FOLD (the parent computed `resolvedInterceptors()` and passed
   * the value), not a per-op parent-walk. Composed OUTERMOST of this harness's
   * own `this.middleware` per op; `[]` when top-of-tree.
   * @see BaseHarnessOptions.inheritedInterceptors
   */
  protected readonly inheritedInterceptors: readonly Middleware<unknown, unknown, unknown>[];
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
   * ADR 76 — structural middleware inheritance (tier 3) as a CONSTRUCTION-FOLD.
   *
   * The value a parent hands its children: this harness's inherited layer
   * (folded in at construction) followed by its OWN registered middleware,
   * ordered **root-outermost** — `[...inheritedInterceptors, ...ownMiddleware]`.
   * A child snapshots this at ITS construction (`inheritedInterceptors:
   * parent.resolvedInterceptors()`), so the cascade is a static fold down the
   * scope chain, not a per-op walk up a parent pointer. Mirrors {@link Hooks}
   * (ADR 82): the fold IS the walk, memoized at each node.
   *
   * Guards (`.guard()`) and transforms (`.use()`) both live on `this.middleware`,
   * so both inherit through this one seam. Snapshots the OWN chain live, so a
   * child sees registrations made on the parent BEFORE the child was
   * constructed; registrations made AFTER are outside the child's static fold.
   */
  protected resolvedInterceptors(): readonly Middleware<unknown, unknown, unknown>[] {
    // Inherited layer is broader scope → outermost → first in the list.
    return [...this.inheritedInterceptors, ...this.middleware.snapshot()];
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
    return this.middleware.use(
      tagInterceptor("guard", mw) as Middleware<unknown, unknown, unknown>,
    );
  }

  /**
   * INTROSPECTION (ADR 83) — enumerate the effective interceptor
   * kinds for `opName`, in composed (outermost-first) order after the
   * guard-outermost sort. Proves the collapsed seam stays enumerable: guards,
   * transforms, and observers are one list, not two disjoint mechanisms. Omits
   * the tier-4 (FiberRef) call-scoped middleware, which is only resolvable
   * in-fiber.
   */
  listInterceptors(opName: string): InterceptorKind[] {
    const assembled = [
      ...this.inheritedInterceptors,
      ...this.middleware.snapshot(),
      ...this.hooks.forOp(opName),
    ];
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
    this.hooks = options.hooks ?? Hooks.empty;
    this.inheritedInterceptors = options.inheritedInterceptors ?? [];

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

            // 3. Append the `before` marker (observe-only). The verdict GUARD
            //    is no longer a distinct phase — it collapsed into the ONE
            //    composed-interceptor seam below (a `guard`-kind interceptor
            //    raising an OperationSignal). This event is kept verbatim so
            //    subscribers still see the phase boundary.
            yield* this.publish(this.makeEvent(resolvedOp, "before", scope));

            // 4. Assemble the ONE interceptor list around the body and compose
            //    it. Assembly order (outermost → innermost):
            //      call-scoped (tier 4, FiberRef — broadest)
            //        → inherited layer (tier 3, folded at construction — no
            //          walk; the parent's `resolvedInterceptors()` snapshot)
            //          → this harness's own middleware (tier 2, read locally
            //            per op, incl. guards from `.guard()`)
            //            → command hooks (ADR 82)
            //    Then a STABLE guard-outermost sort floats every `guard`-kind
            //    interceptor ahead of the transforms (deny-before-transform),
            //    preserving tier order within each kind. Everything reduces to
            //    a pass-through when nothing is registered.
            const callMiddleware = yield* getCallMiddleware;
            const assembled = [
              ...callMiddleware,
              ...this.inheritedInterceptors,
              ...this.middleware.snapshot(),
              ...this.hooks.forOp(resolvedOp.name),
            ];
            const composed = composeMiddleware<I, R, E>(
              orderInterceptors(assembled) as Middleware<I, R, E>[],
              body,
            );
            // Settle: a raised OperationSignal (from a guard) maps to its
            // terminal (vetoed/replaced/deferred); a real failure re-raises
            // ORIGINAL (identity-preserving) after terminal:failed; success
            // emits terminal:succeeded. `catchAll` sees only the typed-failure
            // channel — defects/interrupts pass through untouched, exactly as
            // the prior `tapError` did.
            return yield* composed(resolvedOp.input).pipe(
              Effect.tap((value) =>
                this.publishTerminal(resolvedOp, scope, "succeeded", { result: value }),
              ),
              Effect.catchAll((err) =>
                isOperationSignal(err)
                  ? this.terminateFromSignal<R>(resolvedOp, scope, err)
                  : this.publishTerminal(resolvedOp, scope, "failed", {
                      error: this.normalizeError(err),
                    }).pipe(Effect.zipRight(Effect.fail(err))),
              ),
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
   * Map a guard-raised {@link OperationSignal} to its terminal
   * (ADR 83). `veto` → terminal `vetoed` + `OperationOutcomeError`;
   * `replace` → terminal `replaced` + success(`result`); `defer` → terminal
   * `deferred` + `OperationOutcomeError`. The interceptor-seam twin of the old
   * before-phase verdict switch.
   */
  private terminateFromSignal<R>(
    op: Operation<unknown, R, unknown>,
    scope: EventScope,
    signal: OperationSignal,
  ): Effect.Effect<R, OperationOutcomeError | JournalError, never> {
    switch (signal._signal) {
      case "veto":
        return this.terminate<R>(op, scope, "vetoed", { reason: signal.reason });
      case "replace":
        return this.terminate<R>(op, scope, "replaced", {
          result: (signal as OperationReplace<R>).result,
          reason: signal.reason,
        });
      case "defer":
        return this.terminate<R>(op, scope, "deferred", { retryAfter: signal.retryAfter });
    }
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
