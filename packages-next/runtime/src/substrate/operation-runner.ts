/**
 * OperationRunner (ADR 19/76/83 + Tier 2) — the operation-execution substrate
 * as a standalone, per-harness deployable instance.
 *
 * A2.4 extracted the command-DECLARATION layer ({@link createCommandRunner});
 * it left the operation-EXECUTION layer (the heavy path everything downstream of
 * a manufactured {@link Operation} routes through) fused to {@link BaseHarness},
 * earmarked as this Tier-2 `createOperationRunner`. This module completes the
 * split: it owns the phase contract, idempotency replay, the interceptor
 * cascade, identity stamping, journaling/bus routing, and the terminal
 * machinery. `createCommandRunner` composes on top via the injected
 * {@link RunOperation} capability — one bound `runOperation` per harness.
 *
 * **What is injected vs owned.** The runner owns everything it can hold as its
 * OWN state or module-level state: the policy, the journal/bus handles, the
 * identity slots (`surface`/`principal`), the tier-4 call-scoped middleware
 * FiberRef ({@link withCallMiddleware}), and the whole terminal/event
 * machinery. The TWO things it cannot own are injected as capability closures,
 * because they are the CONSTRUCTION-TREE state that lives on the harness:
 *
 *   - {@link OperationRunnerDeps.interceptors} — the tier-2 (`.use`/`.guard`/
 *     `.hook`) + tier-3 (inherited, LIVE per ADR 83 §4) middleware snapshot.
 *     Live inheritance (`interceptorParent`, the descendant Set, push-on-
 *     register) is inherently the harness's position in the construction tree;
 *     it CANNOT move to a per-op executor. The runner reads the assembled
 *     construction-tree list through this closure each op and composes the
 *     tier-4 FiberRef list (which it DOES own) outermost of it.
 *   - {@link OperationRunnerDeps.spanAttributes} — the harness's `protected`,
 *     override-designed `spanAttributes(op)` seam (ADR 78). Kept on the harness
 *     so the override point is preserved; the runner calls it via the closure.
 *
 * Each `createOperationRunner` call yields an isolated instance — the module
 * holds NO shared journal/bus/policy (only the tier-4 FiberRef, which is
 * process-global by design, exactly as the RuntimeContext FiberRef is).
 *
 * **Lineage — this is v2's successor to v1's `Procedure`** (v1
 * `packages/kernel` `createProcedure`). The mapping is direct:
 *
 *   - v1 Procedure middleware        → the interceptor cascade (tiers 2–4 +
 *                                      guards, composed per op).
 *   - v1 `withTimeout` / abort       → Effect fiber interruption, plus the
 *                                      guard signal → terminal mapping
 *                                      ({@link OperationSignal} → vetoed /
 *                                      deferred / replaced).
 *   - v1 `ProcedurePromise` / `.result` → the terminal contract (succeeded /
 *                                      failed / canceled / … resolved through
 *                                      {@link RunOperation}'s success + `E`
 *                                      channels).
 *   - v1 streaming procedures        → `commandStream` on the CommandRunner
 *                                      above (sink-fold body, same cascade).
 *
 * What v2 ADDS over the bare Procedure: journaling, bus emission, the phase
 * contract (requested → before → terminal), and idempotent replay
 * (`lookupTerminal`) — i.e. DURABLE + OBSERVABLE execution, not just wrapped
 * invocation. That makes this the core execution kernel of a v2 deployment;
 * {@link BaseHarness} retains only identity, inbox, channels, and lifecycle
 * around it.
 *
 * **`runOperation` IS the Effect-native (`fx`) form by construction** — it
 * returns an un-run `Effect`, so an in-fiber caller composes it with `yield*`
 * and rides the SAME cascade + FiberRef context. The Promise face is purely the
 * `runHarnessProtocol` bridge (in `harness-protocol.ts`); there is no second
 * execution path. A harness's `get fx()` command proxy therefore still routes
 * through `CommandRunner.commandEffect` → this `runOperation`, unchanged by the
 * extraction.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §`BaseHarness`
 * @see docs/proposals/v2/blueprint/76-interceptor-tiers.md
 * @see docs/proposals/v2/blueprint/83-interceptor-collapse.md
 * @see docs/proposals/v2/STATUS.md — ROADMAP Tier 2 (createOperationRunner)
 */

import { Effect, type Runtime } from "effect";
import { omitUndefined } from "@agentick/utils-next";
import type {
  CommandOutcome,
  EventPhase,
  EventScope,
  JournalError,
  JournalingPolicy,
  Middleware,
  Operation,
  OperationJournal,
  EventBus,
  ProtocolEvent,
  SubstrateError,
  TerminalEvent,
} from "@agentick/spec-next";
import {
  AgentickError,
  deriveHookNames,
  parseHookKey,
  registerAgentickError,
} from "@agentick/spec-next";
import { getContext, type RuntimeContext, withContext } from "./runtime-context.js";
import { ulid } from "./ulid.js";
import {
  composeMiddleware,
  getCallMiddleware,
  InterceptorCtxRef,
  type InterceptorCtx,
} from "./middleware.js";
import {
  isOperationSignal,
  orderInterceptors,
  type OperationReplace,
  type OperationSignal,
} from "./op-signals.js";

// ============================================================================
// Public shapes
// ============================================================================

/**
 * The heavy-path operation executor's function type — the exact signature of
 * {@link OperationRunner.runOperation}, and the capability
 * {@link createCommandRunner} injects. Manufactures nothing itself: the caller
 * hands a fully-built {@link Operation} + its body; journaling, idempotency,
 * the phase contract, the interceptor cascade, and identity stamping all live
 * behind it.
 */
export type RunOperation = <I, R, E>(
  op: Operation<I, R, E>,
  body: (input: I) => Effect.Effect<R, E, never>,
) => Effect.Effect<R, E | SubstrateError, never>;

/** Policy routing decision for one event shape. */
type PolicyDecision = "always" | "journal" | "bus-only" | "drop";

/**
 * The operation-execution substrate as an instance. One per harness; owns the
 * phase contract + terminal machinery and exposes the event helpers the
 * harness's LIGHT path (`emit` / `emitDelta*`) delegates to (they share
 * identity stamping + policy routing with the heavy path).
 */
export interface OperationRunner {
  /**
   * Run an operation through the full phase contract:
   *
   *   idempotency check → requested → before (interceptor cascade) →
   *   body → terminal
   *
   * Establishes the `RuntimeContextRef` FiberRef for the command's lifetime
   * (sessionId/executionId/tickId/opId/parentOpId/correlationId), auto-threads
   * `parentOpId` from the ambient scope, and settles a guard-raised
   * {@link OperationSignal} into its terminal.
   */
  readonly runOperation: RunOperation;
  /**
   * Build a {@link ProtocolEvent} from an operation — the identity stamp
   * (`opId`/`parentOpId`/`surface`, and the AUTHORITATIVE construction-bound
   * `principal`, ADR 48). Shared by the heavy path (requested/before/terminal)
   * and the light path (`emitDelta`).
   */
  makeEvent(
    op: Operation<unknown, unknown, unknown>,
    phase: EventPhase,
    scope: EventScope,
    extra?: { payload?: unknown; outcome?: CommandOutcome; error?: ProtocolEvent["error"] },
  ): ProtocolEvent;
  /** Publish to bus + (conditionally) journal per {@link JournalingPolicy}. */
  publish(envelope: ProtocolEvent): Effect.Effect<void, JournalError, never>;
  /**
   * Policy routing keyed by the cheapest-to-compute envelope subset
   * (name + phase) — lets the harness's lazy emitters decide whether to build
   * the envelope at all before paying ULID + timestamp + payload cost.
   */
  decideFromShape(name: string, phase: EventPhase): PolicyDecision;
}

/** Construction dependencies for {@link createOperationRunner}. */
export interface OperationRunnerDeps {
  /** The declaring harness's event surface — the default `surface` on emitted events. */
  readonly surface: string;
  /**
   * Construction-bound owning principal (ADR 48), stamped AUTHORITATIVELY onto
   * every emitted event scope by {@link OperationRunner.makeEvent}. `undefined`
   * for principal-less deployments.
   */
  readonly principal: string | undefined;
  /** The operation journal — idempotency lookup + durable append per policy. */
  readonly journal: OperationJournal;
  /** The event bus — every emitted envelope appends here. */
  readonly bus: EventBus;
  /** Journaling policy (ADR — `DEFAULT_JOURNALING_POLICY` unless overridden). */
  readonly policy: JournalingPolicy;
  /**
   * The harness's CONSTRUCTION-TREE interceptor snapshot (tier 2 own +
   * tier 3 inherited), assembled fresh per op. Injected as a closure because
   * live inheritance (ADR 83 §4) is harness state the runner cannot own; the
   * runner composes the tier-4 call-scoped list (which it DOES own) outermost
   * of this. Ordered root-outermost (`[...inherited, ...own]`).
   */
  readonly interceptors: () => readonly Middleware<unknown, unknown, unknown>[];
  /**
   * The harness's overridable {@link OperationRunner} span attributes (ADR 78)
   * — kept on the harness as a `protected` override seam and reached here via
   * this closure, so subclass overrides still take effect.
   */
  readonly spanAttributes: (
    op: Operation<unknown, unknown, unknown>,
  ) => Readonly<Record<string, unknown>>;
  /**
   * Build the facet-decorated {@link InterceptorCtx} handed to this op's
   * interceptor cascade (ADR 64/78/19/83) — the harness owns it because the
   * facets need harness-level deps (`emitLog`, the telemetry provider, the
   * bound `runOperation`). The runner captures the op runtime IN-FIBER (inside
   * the op span) and calls this so `ctx.trace` / `ctx.run` parent under the op;
   * it then stashes the result on {@link InterceptorCtxRef} for the cascade.
   * Absent ⇒ interceptors get the detached off-path ctx (bare runners in
   * tests). Only invoked when the op actually has interceptors.
   */
  readonly buildInterceptorCtx?: (
    ctxScope: RuntimeContext,
    scope: EventScope,
    runtime: Runtime.Runtime<never>,
  ) => InterceptorCtx;
}

/**
 * Construct an {@link OperationRunner} bound to one harness's substrate +
 * construction-tree closures. Stateless at the module level (bar the
 * process-global tier-4 FiberRef) — every instance owns its own journal / bus /
 * policy / identity.
 */
export function createOperationRunner(deps: OperationRunnerDeps): OperationRunner {
  return new OperationRunnerImpl(deps);
}

// ============================================================================
// Implementation
// ============================================================================

class OperationRunnerImpl implements OperationRunner {
  private readonly surface: string;
  private readonly principal: string | undefined;
  private readonly journal: OperationJournal;
  private readonly bus: EventBus;
  private readonly policy: JournalingPolicy;
  private readonly interceptors: () => readonly Middleware<unknown, unknown, unknown>[];
  private readonly spanAttributesFn: (
    op: Operation<unknown, unknown, unknown>,
  ) => Readonly<Record<string, unknown>>;
  private readonly buildInterceptorCtx?: (
    ctxScope: RuntimeContext,
    scope: EventScope,
    runtime: Runtime.Runtime<never>,
  ) => InterceptorCtx;

  constructor(deps: OperationRunnerDeps) {
    this.surface = deps.surface;
    this.principal = deps.principal;
    this.journal = deps.journal;
    this.bus = deps.bus;
    this.policy = deps.policy;
    this.interceptors = deps.interceptors;
    this.spanAttributesFn = deps.spanAttributes;
    this.buildInterceptorCtx = deps.buildInterceptorCtx;
  }

  // ──────── the heavy path ────────

  readonly runOperation: RunOperation = <I, R, E>(
    op: Operation<I, R, E>,
    body: (input: I) => Effect.Effect<R, E, never>,
  ): Effect.Effect<R, E | SubstrateError, never> =>
    Effect.gen(this, function* () {
      // Auto-set parentOpId from the surrounding FiberRef when the caller
      // didn't supply one. This is what makes nested `runOperation` calls
      // compose into a causality tree without app code threading parentOpId
      // by hand.
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
        // The op's authorization identity (ADR 51) — `"host"` / `"wire"` /
        // `"model"` / `"inbox"`. `RuntimeContext extends EventScope`, which
        // declares `origin`; threading it here lets a command handler read
        // "how was I invoked" via `getContext` (e.g. the gates:override audit's
        // origin stamp) without unpacking an envelope. Undefined when the op
        // carries no origin.
        origin: scope.origin,
        opId: resolvedOp.opId,
        parentOpId: resolvedOp.parentOpId,
        correlationId: resolvedOp.correlationId,
        // ADR 83 amendment — the op's command SUFFIX, the same Pascal key the
        // old `hookLayer` map keyed on. An `on<Command>` middleware self-scopes
        // by comparing `ctx.op` to this (see `scopeToCommand`).
        op: parseHookKey(deriveHookNames(resolvedOp.name)[0])?.command,
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

            // 2. Append `requested`. The blueprint's phase contract pins
            //    requested as "argument bound" — the envelope's payload IS the
            //    operation's input so any subscriber (eval ledgers, OTel
            //    exporters, replay harnesses) sees what was invoked without
            //    having to reach into the operation by opId.
            yield* this.publish(
              this.makeEvent(resolvedOp, "requested", scope, { payload: resolvedOp.input }),
            );

            // 3. Append the `before` marker (observe-only). The verdict GUARD is
            //    no longer a distinct phase — it collapsed into the ONE composed-
            //    interceptor seam below (a `guard`-kind interceptor raising an
            //    OperationSignal). This event is kept verbatim so subscribers
            //    still see the phase boundary.
            yield* this.publish(this.makeEvent(resolvedOp, "before", scope));

            // 4. Assemble the ONE interceptor list around the body and compose
            //    it. Assembly order (outermost → innermost):
            //      call-scoped (tier 4, FiberRef — broadest, owned here)
            //        → the harness's construction-tree snapshot (tier 3 inherited
            //          + tier 2 own, injected via `this.interceptors()`; incl.
            //          guards from `.guard()` and command hooks as op-scoped
            //          `transform` middleware — ADR 83 amendment)
            //    Then a STABLE guard-outermost sort floats every `guard`-kind
            //    interceptor ahead of the transforms (deny-before-transform),
            //    preserving tier order within each kind. Everything reduces to a
            //    pass-through when nothing is registered. Each hook self-filters
            //    by `ctx.op` (the command suffix set on the RuntimeContext above).
            const callMiddleware = yield* getCallMiddleware;
            const assembled = [...callMiddleware, ...this.interceptors()];
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
            const core = composed(resolvedOp.input).pipe(
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
            );
            // Land the facet-bearing InterceptorCtx (ADR 64/78/19/83) for the
            // cascade — ONLY when the op actually has interceptors AND a builder
            // is wired (bare runners skip it → detached off-path ctx). Capture
            // the op runtime IN-FIBER, inside the op span opened by
            // `withOperationSpan` below, so `ctx.trace` child spans + `ctx.run`
            // ops parent under this op.
            const withCtx =
              this.buildInterceptorCtx !== undefined && assembled.length > 0
                ? Effect.gen(this, function* () {
                    const runtime = yield* Effect.runtime<never>();
                    const ictx = this.buildInterceptorCtx!(ctxScope, scope, runtime);
                    return yield* Effect.locally(
                      InterceptorCtxRef,
                      ictx as InterceptorCtx | undefined,
                    )(core);
                  })
                : core;
            return yield* withCtx.pipe(this.withOperationSpan(resolvedOp));
          }),
        ),
      );
    });

  /**
   * Wrap an Effect in an OTel span using the standard `Effect.withSpan`, keyed
   * on the op's name with the harness's (overridable) span attributes.
   *
   * Effect's `withSpan` enhances failure stack traces with span context by
   * reconstructing top-level failure values (the outer object the effect failed
   * with). Inner Error references and tagged-union fields like `.cause` are
   * preserved as-is — deep-equality, instanceof, `_tag` matching, and
   * property-based access all work normally. Only a top-level
   * `=== originalError` identity check on the outer failure object will see a
   * different reference. Adopters who need such identity matching should reach
   * for `_tag` or `instanceof` instead.
   *
   * @see docs/proposals/v2/blueprint/17-open-questions.md §L5
   */
  private withOperationSpan<A, E>(
    op: Operation<unknown, unknown, unknown>,
  ): (eff: Effect.Effect<A, E, never>) => Effect.Effect<A, E, never> {
    const attributes = this.spanAttributesFn(op);
    return (eff) => eff.pipe(Effect.withSpan(op.name, { attributes }));
  }

  // ──────── event helpers (shared heavy + light path) ────────

  makeEvent(
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
      // operation carries — an op cannot emit an event claiming a different
      // principal than its harness (no per-op identity spoofing, ADR 45).
      // `omitUndefined` keeps the rebuilt scope clean. Principal-less harnesses
      // pass the op scope through untouched (zero-cost — the universal hot path
      // is unaffected).
      scope:
        this.principal !== undefined
          ? omitUndefined({ ...scope, principal: this.principal })
          : scope,
      payload: extra?.payload,
      outcome: extra?.outcome,
      error: extra?.error,
    } as ProtocolEvent;
  }

  publish(envelope: ProtocolEvent): Effect.Effect<void, JournalError, never> {
    const decision = this.decideFromShape(envelope.name, envelope.phase);
    if (decision === "drop") return Effect.void;
    if (decision === "always" || decision === "journal") {
      return Effect.zipRight(this.bus.append(envelope), this.journal.append(envelope));
    }
    return this.bus.append(envelope);
  }

  /**
   * Policy routing keyed by the cheapest-to-compute envelope subset (name +
   * phase). Decision order:
   *   1. `policy.override[exactName]`  drop | bus-only | always
   *   2. `policy.override[prefix]`     longest-prefix match
   *   3. `policy.alwaysJournal` / `policy.busOnly` phase rules
   *   4. Default-deny (bus-only) on unknown phases
   */
  decideFromShape(name: string, phase: EventPhase): PolicyDecision {
    const override = this.policy.override ? matchOverride(name, this.policy.override) : undefined;
    if (override === "drop") return "drop";
    if (override === "always") return "always";
    if (override === "bus-only") return "bus-only";
    if (this.policy.alwaysJournal.includes(phase)) return "journal";
    if (this.policy.busOnly.includes(phase)) return "bus-only";
    return "bus-only";
  }

  // ──────── terminal machinery ────────

  /**
   * Publish-only terminal — emits the `terminal` envelope but does not raise
   * OperationOutcomeError. Used on the failure path where the caller wants to
   * re-raise the original error after journaling.
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
   * Map a guard-raised {@link OperationSignal} to its terminal (ADR 83).
   * `veto` → terminal `vetoed` + `OperationOutcomeError`; `replace` → terminal
   * `replaced` + success(`result`); `defer` → terminal `deferred` +
   * `OperationOutcomeError`. The interceptor-seam twin of the old before-phase
   * verdict switch.
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
 * Surfaced through the {@link RunOperation} failure channel when an operation
 * terminates with a non-success outcome (failed, canceled, vetoed, deferred).
 * The `terminal` field exposes the typed envelope.
 *
 * On the `failed` path, the substrate publishes the terminal:failed envelope
 * BUT re-raises the body's original typed error rather than wrapping in
 * `OperationOutcomeError`. Veto / canceled / deferred / the replay path for
 * cached failed terminals use this error class so the caller can pattern-match.
 *
 * Class home is `@agentick/runtime-next` (ADR 41); referenced structurally by
 * the spec-side `SubstrateError` union. Subclass of {@link AgentickError} —
 * `err instanceof AgentickError` narrows to the framework-error root.
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
