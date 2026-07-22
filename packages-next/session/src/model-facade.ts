/**
 * `session.model` — the model selection / swap FACADE (ADR 89 §2).
 *
 * NOT a new harness. A thin facade over state the SESSION already owns:
 * the construction-bound default `RegisteredModel` (`this.modelExecutor`
 * + `this.target`), which `setModel` / `setTarget` swap, and a
 * session-scoped interceptor list that rides the ADR-76 tier-4
 * call-scoped middleware seam so it PERSISTS across those swaps.
 *
 * ## Why a facade, not a harness
 *
 * A model swap can swap the whole executor (a different adapter), so the
 * one thing command-ifying the executor (§1) does NOT give you is
 * interceptors that survive a `setModel` swap (a cost-guard registered on
 * executor-A is gone once you swap to executor-B). The session is the
 * stable layer that already owns the default + the per-tick
 * `resolveModel` + the `input.modelExecutor ?? this.modelExecutor`
 * override, so cross-swap concerns live HERE, exposed as this facade —
 * not a whole new harness sibling. The escape hatch (promote to a real
 * `BaseHarness` if the model layer ever needs its own identity /
 * inbox-addressability / lifecycle FSM) is documented in ADR 89 §2.
 *
 * ## How cross-swap persistence works
 *
 * `use` / `guard` register interceptors op-scoped to the
 * `model:generate[_stream]` commands (ADR 89 §1). They are NOT registered
 * on any executor instance — the loop may run a per-tick `<Model>`-swapped
 * executor (ADR 56), and `setModel` swaps the session default, so an
 * executor-instance registration would evaporate. Instead they ride the
 * SAME seam the §4 lifecycle projection uses: the session threads
 * `model.callMiddleware()` into `withCallMiddleware(...)` around each
 * `loop.fx.runExecution`, and the ADR-77 one-fiber spine propagates it to
 * WHICHEVER executor issues this send's model calls. Registered once, they
 * apply across every subsequent swap — the §2 payoff.
 *
 * @see docs/proposals/v2/blueprint/89-model-harness-and-lifecycle-projection.md §2
 */

import { Effect } from "effect";

import {
  deriveHookNames,
  getContext,
  liftMiddleware,
  signalFromVerdict,
  tagInterceptor,
  type AsyncMiddleware,
  type Middleware,
  type RuntimeContext,
  type Unsubscribe,
} from "@agentick/runtime-next";
import { isLanguageModelAdapter, type LanguageModelAdapter } from "@agentick/model-next";
import {
  ModelExecutorBuilderMissingError,
  type ExecutionTarget,
  type ExecutorProtocol,
  type HandlerVerdict,
  type LanguageModelExecutionResult,
  type RegisteredModel,
} from "@agentick/spec-next";

// The concrete model-executor slot type the session default holds — the
// same shape `SessionHarnessOptions.modelExecutor` and `RegisteredModel`
// use. Re-aliased for the facade's construction surface.
type ModelExecutor = ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult>;

/**
 * The `session:set-model` command input (ADR 89 §2). Both `setModel` and
 * `setTarget` route through the one command so a swap is journaled +
 * hookable (`onBeforeSessionSetModel` policy — "this session may not
 * switch to model X"). `target` is always present; `modelExecutor` is
 * omitted by `setTarget` (keep the current runner, change only the LLM
 * target it points at).
 */
export interface SetModelInput {
  readonly modelExecutor?: ModelExecutor;
  readonly target: ExecutionTarget;
}

/**
 * `session.model` — the model selection / swap facade (ADR 89 §2).
 *
 * `setModel` / `setTarget` replace the session-default `RegisteredModel`;
 * `use` / `guard` register session-scoped interceptors on the model call
 * that persist across those swaps.
 */
export interface ModelSelectionHandle {
  /**
   * The session-default {@link RegisteredModel} in effect right now, or
   * `undefined` on a model-less session (no `model`/`modelExecutor` at
   * construction and no `setModel` since). A model-less session is legal — the
   * model is enforced at execution time, not construction.
   */
  readonly current: RegisteredModel | undefined;
  /**
   * Swap the session-default model — the runner AND its target. Replaces
   * the construction-bound default the session holds; takes effect on the
   * NEXT send (never mid-execution). Journaled + hookable via the
   * `session:set-model` command (`onBeforeSessionSetModel` may veto).
   *
   * Accepts either overload form — the ergonomic parity with construction
   * (`createApp({ model: openai("gpt-4o") })`):
   *
   *   - A {@link RegisteredModel} (`{ modelExecutor, target }`) — BYO
   *     executor, used as-is.
   *   - A `LanguageModelAdapter` (`openai("gpt-4o")`, `anthropic(...)`, …) —
   *     wrapped in an executor for you by the session's injected
   *     `buildModelExecutor`. Throws {@link ModelExecutorBuilderMissingError}
   *     when the session was constructed without a builder (a BYO-executor
   *     app); pass a `RegisteredModel` there instead.
   *
   * Both forms normalize to a `RegisteredModel` BEFORE the `session:set-model`
   * command, so the veto path (`onBeforeSessionSetModel`) sees identical input.
   */
  setModel(model: RegisteredModel | LanguageModelAdapter): Promise<void>;
  /**
   * Swap ONLY the session-default target (keep the current runner) — e.g.
   * switch modelId to a cheaper model on the same adapter. Journaled +
   * hookable exactly like {@link setModel}.
   */
  setTarget(target: ExecutionTarget): Promise<void>;
  /**
   * Register a session-scoped `transform` interceptor on the
   * `model:generate[_stream]` commands. PERSISTS across `setModel` swaps —
   * it rides the tier-4 call middleware seam, not any executor instance.
   * The ergonomic pure-async surface (`async (input, next) => { … }`).
   * Returns an {@link Unsubscribe}.
   */
  use(mw: AsyncMiddleware): Unsubscribe;
  /**
   * Register a session-scoped `guard` on the `model:generate[_stream]`
   * commands — admission control for the model call (cost ceiling, safety
   * veto, replay/mock `replace`). The decider returns a
   * {@link HandlerVerdict} (`proceed | veto | replace | defer`) or `void`
   * (≡ proceed). PERSISTS across `setModel` swaps. Returns an
   * {@link Unsubscribe}.
   */
  guard<I = unknown, R = unknown>(
    decide: (
      input: I,
      ctx: RuntimeContext,
    ) => HandlerVerdict<R> | void | Promise<HandlerVerdict<R> | void>,
  ): Unsubscribe;
}

/**
 * The session's dependency on itself, injected into the facade so the
 * facade stays a thin projection: `setModel` / `setTarget` route back
 * through the session's `session:set-model` command, and `current` reads
 * the live default off the session.
 */
export interface ModelFacadeHost {
  /** The session-default `RegisteredModel` in effect right now, or `undefined` (model-less). */
  readonly getDefault: () => RegisteredModel | undefined;
  /** Run the journaled + hookable `session:set-model` command. */
  readonly applySetModel: (input: SetModelInput) => Promise<void>;
  /**
   * Adapter→executor builder INJECTED by the app (which owns the
   * adapter→executor build + the substrate it needs — see
   * `AppHarness.createSessionBody`). The facade calls it to normalize the
   * `setModel(adapter)` overload into a {@link RegisteredModel} before the
   * command. `undefined` for a BYO-executor app (no `model` adapter at
   * construction) — the adapter overload then throws
   * {@link ModelExecutorBuilderMissingError}. Keeps the session
   * adapter-agnostic: it never imports executor-construction machinery.
   */
  readonly buildModelExecutor?: (adapter: LanguageModelAdapter) => RegisteredModel;
}

// ── op-scoping ──────────────────────────────────────────────────────
//
// A `runOperation` op stamps `ctx.op` with the PascalCase hook suffix
// (`deriveHookNames("model:command:generate")[0]` → `onBeforeModelGenerate`
// → `ModelGenerate`) — the same value `scopeToCommand` / the declarative
// hook fold compare against. Derive the two model-call op tags from the
// canonical op names so the facade never hardcodes the Pascal strings.
const GENERATE_OP = deriveHookNames("model:command:generate")[0].slice("onBefore".length);
const GENERATE_STREAM_OP = deriveHookNames("model:command:generate_stream")[0].slice(
  "onBefore".length,
);

/** True when the ambient op is one of the model-call commands (ADR 89 §1). */
const isModelGenerateOp = (op: string | undefined): boolean =>
  op === GENERATE_OP || op === GENERATE_STREAM_OP;

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class SessionModelFacade implements ModelSelectionHandle {
  private readonly host: ModelFacadeHost;
  /**
   * The session-scoped model interceptors (ADR 89 §2), in registration
   * order. The session snapshots this via {@link callMiddleware} into the
   * tier-4 `withCallMiddleware(...)` list around every `loop.fx
   * .runExecution`, so they reach whichever executor issues the model
   * call — and survive `setModel` swaps because they live HERE, not on an
   * executor instance.
   */
  private readonly interceptors: Middleware<unknown, unknown, unknown>[] = [];

  constructor(host: ModelFacadeHost) {
    this.host = host;
  }

  get current(): RegisteredModel | undefined {
    return this.host.getDefault();
  }

  // `async` so a bad-adapter throw (no injected builder) surfaces as a REJECTED
  // promise, uniform with the RegisteredModel path — never a synchronous throw.
  async setModel(model: RegisteredModel | LanguageModelAdapter): Promise<void> {
    // Normalize BOTH overload forms to a RegisteredModel BEFORE the command,
    // so the veto path (`onBeforeSessionSetModel`) sees identical input. A bare
    // adapter is wrapped via the app-injected builder; a RegisteredModel is
    // used as-is. `isLanguageModelAdapter` is the canonical guard (shared with
    // the app's construction slot) — a RegisteredModel has no `buildParams`
    // and its `modelExecutor` carries `run`/`execute`, so it never matches.
    const registered = isLanguageModelAdapter(model) ? this.buildFromAdapter(model) : model;
    await this.host.applySetModel({
      modelExecutor: registered.modelExecutor,
      target: registered.target,
    });
  }

  /**
   * Wrap a bare `LanguageModelAdapter` in a `RegisteredModel` via the
   * app-injected {@link ModelFacadeHost.buildModelExecutor}. Throws
   * {@link ModelExecutorBuilderMissingError} when no builder was injected (a
   * BYO-executor app) — the session itself never constructs executors.
   */
  private buildFromAdapter(adapter: LanguageModelAdapter): RegisteredModel {
    const build = this.host.buildModelExecutor;
    if (build === undefined) throw new ModelExecutorBuilderMissingError();
    return build(adapter);
  }

  setTarget(target: ExecutionTarget): Promise<void> {
    return this.host.applySetModel({ target });
  }

  use(mw: AsyncMiddleware): Unsubscribe {
    const scoped: AsyncMiddleware = (input, next, ctx) =>
      isModelGenerateOp(ctx.op) ? mw(input, next, ctx) : next(input);
    return this.push(tagInterceptor("transform", liftMiddleware(scoped)));
  }

  guard<I = unknown, R = unknown>(
    decide: (
      input: I,
      ctx: RuntimeContext,
    ) => HandlerVerdict<R> | void | Promise<HandlerVerdict<R> | void>,
  ): Unsubscribe {
    const mw: Middleware<unknown, unknown, unknown> = (input, next) =>
      Effect.gen(function* () {
        const ctx = yield* getContext;
        if (!isModelGenerateOp(ctx.op)) return yield* next(input);
        const raw = decide(input as I, ctx);
        const verdict =
          (isThenable(raw)
            ? ((yield* Effect.promise(() => raw)) as HandlerVerdict<R> | void)
            : (raw as HandlerVerdict<R> | void)) ?? ({ kind: "proceed" } as const);
        if (verdict.kind === "proceed") return yield* next(input);
        // Raise the control-signal on the failure channel — `runOperation`'s
        // settle maps it to the matching terminal (vetoed / replaced /
        // deferred). Because the interceptor is `guard`-tagged it composes
        // OUTERMOST, so no transform can swallow the veto.
        return yield* Effect.fail(signalFromVerdict(verdict));
      });
    return this.push(tagInterceptor("guard", mw));
  }

  /**
   * Snapshot of the session-scoped model interceptors, for the session to
   * fold into the tier-4 `withCallMiddleware(...)` list per send. A copy so
   * a mid-send registration/unsubscribe can't mutate the in-flight list.
   */
  callMiddleware(): readonly Middleware<unknown, unknown, unknown>[] {
    return this.interceptors.slice();
  }

  private push(mw: Middleware<unknown, unknown, unknown>): Unsubscribe {
    this.interceptors.push(mw);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const idx = this.interceptors.indexOf(mw);
      if (idx >= 0) this.interceptors.splice(idx, 1);
    };
  }
}

// ── SessionHarnessProtocol augmentation (ADR 27 pattern) ────────────
//
// `session.model` is intrinsic session functionality (not an optional
// harness), so the session package itself augments the protocol's session
// surface with the facade slot — the same module-augmentation move the
// built-in harness packages (knobs / timeline / gates) use for their
// session-level handles.
declare module "@agentick/spec-next" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's model selection / swap facade (ADR 89 §2) —
     * `setModel` / `setTarget` swap the session-default model;
     * `use` / `guard` register session-scoped interceptors on the model
     * call that persist across those swaps.
     */
    readonly model: ModelSelectionHandle;
  }
}
