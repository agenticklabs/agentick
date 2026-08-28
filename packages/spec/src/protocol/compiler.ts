/**
 * CompilerProtocol — the contract every compiler harness
 * implementation satisfies.
 *
 * The reference implementation is `@agentick/compiler-react` (Phase 3),
 * which uses `react-reconciler` to drive a JSX tree. Future
 * implementations on alternative substrates (imperative builders,
 * Vue/Solid hosts, …) MUST satisfy the same contract and pass
 * `runCompilerConformance`.
 *
 * ## Design constraints baked into this protocol
 *
 * - **Fully-resolved IR.** `RenderedTree` reflects a fully-resolved
 *   component tree. The render-until-stable loop blocks on async
 *   `DataBridge.resolve` calls (Suspense primitive — thrown Promises)
 *   and only emits a terminal result when the tree is stable — or
 *   terminates with `outcome: "failed"` when resolution cannot
 *   complete.
 * - **React feature semantics:** the compiler uses React's compiler,
 *   component model, hooks, refs, effects, and context. The following
 *   React features have specific semantics:
 *     - `<Suspense fallback>` — allowed, but fallback content may
 *       appear in the IR if a boundary fires. The framework does NOT
 *       detect or guard against this — Suspense's catch-and-fallback
 *       behavior is React's native lifecycle and Compiler harness
 *       implementations don't interpose. Authors who don't want
 *       fallback leakage should avoid `<Suspense>` and rely on the
 *       no-Suspense `useData` primitive (which throws Promises caught
 *       by the harness's render-until-stable loop, not by user
 *       Suspense). Verify with your own tests if uncertain.
 *     - `<ErrorBoundary>` (class component `componentDidCatch`) —
 *       SUPPORTED. When a boundary catches a render error, the fallback
 *       lands in the IR; the operation terminates with `succeeded` and
 *       an `error-boundary-active` info diagnostic. The framework owns
 *       a root-level boundary as the final sink; unhandled errors
 *       terminate with `failed`.
 *     - `useTransition`, `useDeferredValue`, `startTransition` —
 *       allowed; no effect (the compiler renders synchronously).
 *     - React Server Components — not supported.
 * - **JSON-shaped output.** `RenderedTree` and `RenderToStringPayload`
 *   cross the spec firewall — no function references, no live SDK clients.
 * - **Bridges, not globals.** Implementations consume `HookBridges`
 *   provided at mount time. Module-level singletons are forbidden.
 * - **Sync render flush.** Implementations SHOULD reconcile
 *   synchronously to completion on each render-until-stable iteration.
 *
 * ## Async return discipline
 *
 * Spec uses `Promise<T>` as the canonical async return type. Errors
 * are thrown / rejected with tagged-union values matching
 * `ReconcileError`. Implementations using Effect bridge at their
 * protocol boundary.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md
 */

import type { InstallerInterceptors } from "./app-extension.js";
import type { HarnessFx, Middleware } from "./middleware.js";
import type { Effect } from "effect";
import type { FormatterRef, RenderedTree, ToolPresentation } from "../data/index.js";
import type { SubstrateError } from "../data/errors.js";
import type { ReconcileErrorChannel } from "../errors/harnesses.js";
import type { ReconcileDiagnostic, RenderToStringPayload } from "../data/compiler-diagnostics.js";
import type { HookBridges } from "./hook-bridges.js";
import type { PromiseView } from "./promise-view.js";
import type { RenderContext } from "./render-context.js";

// ============================================================================
// Common input fragments
// ============================================================================

/**
 * Identity fields shared by every operation that targets a mounted
 * application. `mountId` is the stable address of the mount; `opId` is
 * caller-supplied idempotency.
 */
export interface MountScopedInput {
  readonly mountId: string;
  readonly opId?: string;
  readonly correlationId?: string;
  readonly parentOpId?: string;
}

// ============================================================================
// mount / unmount
// ============================================================================

export interface MountInput extends MountScopedInput {
  /**
   * The React element (or equivalent for non-React compilers) to mount.
   * Opaque to the spec — the reference impl typecasts to
   * `React.ReactNode` internally.
   */
  readonly element: unknown;

  /**
   * Opaque per-mount input for the root of the mounted tree — the carrier
   * of `CreateSessionInput.initialProps`: one app-level root element,
   * per-session variation. The compiler impl defines its interpretation,
   * exactly as it does for `element`.
   */
  readonly rootInput?: unknown;

  readonly sessionId: string;
  /**
   * Per-render facts the tree reads synchronously while producing the IR
   * (ADR 55) — the augmentable {@link RenderContext} envelope. Resolved by
   * the session per render and provided by the compiler as a React
   * context. Its seeded `contextInfo` slot carries the active model's
   * `contextWindow` (+ optional prior `usedTokens`) so adaptive-compaction
   * components react to the window WHILE producing the IR — a synchronous
   * render input, NOT an async lifecycle observation (ADR 54). Packages
   * augment the envelope with further per-render facts (active model,
   * budget, principal).
   */
  readonly renderContext?: RenderContext;
  readonly executionId?: string;

  /** Runtime-supplied bridges. See `HookBridges`. */
  readonly bridges: HookBridges;

  /**
   * Initial formatter binding for the mount. The compiler's host
   * context inherits from this root scope.
   */
  readonly defaultFormatter?: FormatterRef;

  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MountResult {
  readonly mountId: string;
}

export interface UnmountInput extends MountScopedInput {}

// ============================================================================
// rerender
// ============================================================================

/**
 * Replace the mounted element. Used when the runtime hot-swaps the
 * agent definition without tearing down the mount (e.g., during
 * development reloads). Hook state is preserved where component
 * identity is preserved (same React rules).
 */
export interface RerenderInput extends MountScopedInput {
  readonly element: unknown;
  readonly elementVersion?: string;
}

// ============================================================================
// renderTree (the canonical command)
// ============================================================================

/**
 * Why the render is happening. Drives loop-budget defaults and certain
 * contributor decisions (e.g., free-root rendering for `resource`).
 */
export type RenderPurpose =
  | "tick" // a regular tick within an execution loop
  | "resource" // explicit resource render outside of a tick
  | "free-root" // free-form render (e.g., a CLI dump)
  | (string & {});

export interface RenderTreeInput extends MountScopedInput {
  readonly sessionId: string;
  readonly executionId?: string;
  readonly purpose?: RenderPurpose;
  /** Per-render facts for this render (ADR 55) — refreshes the
   *  {@link RenderContext} envelope (window today; active model / budget /
   *  principal via augmented slots). See {@link MountInput.renderContext}. */
  readonly renderContext?: RenderContext;
  /**
   * Stability budget. The render-until-stable loop terminates with a
   * `max-iterations` diagnostic when exceeded. Default: 10.
   */
  readonly maxIterations?: number;
  /**
   * Wallclock budget per iteration's data-fetch wait. The harness races
   * the iteration's pending `useData` fetches against this timeout —
   * when exceeded, the loop terminates with an `await-timeout`
   * diagnostic and returns whatever IR was built so far. Default:
   * unbounded.
   *
   * Use this when you have a slow upstream fetcher and want to fail
   * fast rather than block the loop indefinitely.
   */
  readonly awaitTimeoutMs?: number;
  /**
   * When true, the bridge MAY use cached data without re-validation.
   * When false, the harness invalidates entries past their TTL before
   * the first render.
   */
  readonly useCachedData?: boolean;
  /**
   * Free-form propagation context (correlated request, A/B flags, etc.).
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RenderTreeResult {
  readonly tree: RenderedTree;
  readonly diagnostics: readonly ReconcileDiagnostic[];
  /** Number of render iterations executed before stability. */
  readonly iterations: number;
}

// ============================================================================
// renderToString — render the mount to a string
// ============================================================================

/**
 * Renders the mount and returns the formatted result as a string.
 *
 * Conceptually a thin wrapper:
 *   renderTree → ensure tree.text is populated → return tree.text
 *
 * Phase 3 placeholder: the reference impl synthesizes a default
 * markdown/xml/text serialization from the entire context (sections +
 * messages + free-root) because the formatter harness (Phase 4a) is
 * not yet wired. When the formatter harness lands, the compiler
 * populates `tree.text` from `tree.content` via the formatter, and
 * `renderToString` reduces to returning that string.
 *
 * Subtree extraction is the caller's job — use `renderTree` + filter
 * the entries you want + serialize them yourself. No selector grammar
 * is baked into the spec.
 */
export interface RenderToStringInput extends MountScopedInput {
  /**
   * Override the in-scope formatter for this render. When set, applies
   * to every entry regardless of any `renderedWith` declared via JSX
   * scope providers (`<Markdown>` / `<XML>`). When omitted, per-entry
   * `renderedWith` is honored.
   */
  readonly formatter?: FormatterRef;
  readonly maxIterations?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RenderToStringResult {
  readonly payload: RenderToStringPayload;
  readonly diagnostics: readonly ReconcileDiagnostic[];
  readonly iterations: number;
}

// ============================================================================
// Lifecycle events — the command-hook projection payloads (ADR 89 §4)
// ============================================================================

/**
 * Lifecycle event payloads that user-supplied hooks (`useOnTickStart`,
 * `useOnTickEnd`, `useOnExecutionEnd`, `useOnError`, …) observe.
 *
 * **Tagged union, open-ended.** New event kinds can be added without
 * changing any protocol surface. Implementations dispatch on
 * `event.kind`; unknown kinds are ignored (the harness MAY emit an
 * `info`-severity diagnostic for visibility).
 *
 * **These events are a PROJECTION of the command-hook system (ADR 89
 * §4).** There is no bespoke lifecycle feed: the SESSION (the
 * composition root) registers forwarders on the constituent command
 * hooks (`loop:run-execution`, `loop:tick`, `tool:dispatch`,
 * `model:generate[_stream]`) and dispatches the matching event into
 * the compiler's per-mount lifecycle dispatch (a
 * {@link LifecycleProjectionTarget}). Two projection channels coexist:
 *
 *  - **In-process** — the session's interceptor forwarders →
 *    `dispatchLifecycle` (ordering-sensitive; the tick-end settle is
 *    awaited in the `loop:tick` command cascade, ADR 67).
 *  - **Bus-based fan-out (parallel channel).** The same command
 *    lifecycle is independently emitted as `ProtocolEvent` envelopes on
 *    the shared event bus. Cross-process subscribers (devtools,
 *    telemetry, persistence) observe via the bus without coupling to
 *    the compiler.
 *
 * The two channels are projections of the ONE source — the operation's
 * command lifecycle.
 */
export type LifecycleEvent =
  | LifecycleTickStart
  | LifecycleTickEnd
  | LifecycleExecutionStart
  | LifecycleExecutionEnd
  | LifecycleToolStart
  | LifecycleToolEnd
  | LifecycleModelGenerateStart
  | LifecycleModelGenerateEnd
  | LifecycleError
  | LifecycleCustom;

export interface LifecycleTickStart {
  readonly kind: "tick-start";
  readonly tickId: string;
  readonly executionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LifecycleTickEnd {
  readonly kind: "tick-end";
  readonly tickId: string;
  readonly executionId?: string;
  /**
   * Tick result payload — opaque JSON shape specified by the loop
   * executor protocol. The compiler forwards the value untouched to
   * registered `useOnTickEnd` hooks.
   */
  readonly result: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LifecycleExecutionStart {
  readonly kind: "execution-start";
  readonly executionId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LifecycleExecutionEnd {
  readonly kind: "execution-end";
  readonly executionId: string;
  /**
   * Execution outcome — opaque JSON shape specified by the loop
   * executor protocol (typically the canonical `CommandOutcome`).
   */
  readonly outcome: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A tool dispatch STARTED. Backward-looking (the dispatch is already
 * under way when the loop bridges this) — drives spinners, scratchpad
 * "searching…" affordances, per-tool side-effects. Lights up
 * `useOnToolStart`. `via` records how the call was initiated
 * (`"model"` | `"dispatch"` | …).
 */
export interface LifecycleToolStart {
  readonly kind: "tool-start";
  readonly tickId: string;
  readonly callId: string;
  readonly name: string;
  readonly via: string;
  readonly executionId?: string;
  /**
   * The model's self-narration for this call — the `_summary` field the
   * model filled in (see `TOOL_NARRATION_FIELD`). Extracted eagerly from
   * the raw model input so `useOnToolStart` can light the spinner with
   * "Searching the docs for retry config…" the instant dispatch begins,
   * BEFORE the handler resolves. The full precedence-resolved
   * `ToolPresentation` (which folds `displaySummary`/`title` — only known
   * after validation) rides `DispatchResult.presentation` instead.
   * Undefined for host `dispatch` calls and when narration is disabled.
   */
  readonly narration?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A tool dispatch FINISHED. Carries the terminal `outcome` and
 * `durationMs`. Lights up `useOnToolEnd` (inject corrective context on
 * failure, record results after a search).
 */
export interface LifecycleToolEnd {
  readonly kind: "tool-end";
  readonly tickId: string;
  readonly callId: string;
  readonly name: string;
  readonly outcome: "succeeded" | "failed";
  readonly durationMs: number;
  readonly executionId?: string;
  /**
   * The fully-resolved tool-call presentation — four DISTINCT fields
   * (`name`, `title`, `summary`, `narration`), never collapsed — the
   * executor computed at dispatch, carried back from
   * `DispatchResult.presentation`. Where tool-start's `narration` is the
   * eager live-spinner value (model narration only), THIS is the settled
   * answer — it also carries the author's `summary`/`title` when the model
   * emitted no narration, surfaced distinctly for the client to compose.
   * Absent when the dispatch short-circuited before resolution (e.g. a
   * confirmation denial) or the door produced no presentation.
   */
  readonly presentation?: ToolPresentation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A model call STARTED (`model:generate` / `model:generate_stream`
 * issued the provider call — ADR 89 §1). Projected from
 * `onBeforeModelGenerate[Stream]` via the session's per-send
 * call-scoped forwarders, so it fires for WHICHEVER executor instance
 * runs the tick — including a per-tick `<Model>`-swapped executor
 * (ADR 56). Lights up `useOnModelGenerateStart`.
 */
export interface LifecycleModelGenerateStart {
  readonly kind: "model-generate-start";
  /** `true` when the streaming command (`model:generate_stream`) issued the call. */
  readonly stream: boolean;
  readonly tickId?: string;
  readonly executionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A model call FINISHED (the command succeeded — a provider failure
 * surfaces as a `LifecycleError` with `phase: "model"` instead).
 * Lights up `useOnModelGenerateEnd`.
 */
export interface LifecycleModelGenerateEnd {
  readonly kind: "model-generate-end";
  /** `true` when the streaming command (`model:generate_stream`) issued the call. */
  readonly stream: boolean;
  readonly tickId?: string;
  readonly executionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LifecycleError {
  readonly kind: "error";
  /** Where the error happened — `tick` | `execution` | `tool` | `model` | … */
  readonly phase: string;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly data?: unknown;
  };
  readonly tickId?: string;
  readonly executionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Escape hatch for application-defined lifecycle pass-throughs. The
 * `kind` MUST be namespaced (e.g., `"app:my-app:phase-x"`) to avoid
 * collisions with future framework kinds.
 */
export interface LifecycleCustom {
  readonly kind: string & {};
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface DispatchLifecycleInput extends MountScopedInput {
  readonly event: LifecycleEvent;
}

/**
 * OPTIONAL capability — a compiler that PROJECTS the command-hook
 * lifecycle into in-tree hooks (ADR 89 §4). Not part of
 * {@link CompilerProtocol}: a compiler that has no in-tree lifecycle
 * surface simply doesn't implement it, and the session's projection
 * wiring is skipped (feature-detected via
 * {@link import("../guards/index.js").supportsLifecycleProjection}).
 *
 * `dispatchLifecycle` routes one {@link LifecycleEvent} to the mount's
 * registered handlers (the thin per-mount dispatch + the
 * tick-start/execution-start catch-up cache). The EVENTS come from the
 * session's command-hook forwarders — the compiler owns no feed of its
 * own. Rejects with `NotMounted` for an unknown mount.
 */
export interface LifecycleProjectionTarget {
  dispatchLifecycle(input: DispatchLifecycleInput): Promise<void>;
}

// ============================================================================
// TreeInterceptionSource — the tree's IN-PATH interceptors (ADR 89 §4)
// ============================================================================

/**
 * The query the session's tree-interceptor forwarder issues per operation
 * to pull a mount's currently-registered in-path interceptors.
 *
 * `command` is the ambient op tag (`ctx.op`) — the PascalCase suffix
 * `runOperation` stamps, e.g. `"ToolDispatch"` for `tool:dispatch`,
 * `"ModelGenerate"` for `model:generate`. The tree hooks register under
 * the SAME tag (derived from the `CommandRegistry` key via
 * `deriveHookNames`), so the forwarder collects by exact match.
 */
export interface CollectTreeInterceptorsInput {
  readonly mountId: string;
  /** The ambient op tag (`ctx.op`) — PascalCase command suffix. */
  readonly command: string;
}

/**
 * OPTIONAL capability — a compiler whose tree can register REAL,
 * IN-PATH interceptors (ADR 83 `guard` / `transform`) on the framework's
 * commands (ADR 89 §4, the tree-side other half of the observe-only
 * lifecycle projection). Not part of {@link CompilerProtocol}: a compiler
 * with no in-tree interceptor surface simply doesn't implement it, and the
 * session's forwarder is skipped (feature-detected via
 * {@link import("../guards/index.js").supportsTreeInterception}).
 *
 * `collectTreeInterceptors` returns the {@link Middleware} list a mount's
 * tree currently registers for `command`, in registration order (the
 * session ORDERS guards-outermost + composes them around the op). Unlike
 * {@link LifecycleProjectionTarget.dispatchLifecycle}, this is a PULL — the
 * session's per-send tier-4 forwarder queries the mount at each operation,
 * so a mid-execution mount/unmount is reflected on the next op with no
 * stale registration.
 */
export interface TreeInterceptionSource {
  collectTreeInterceptors(
    input: CollectTreeInterceptorsInput,
  ): readonly Middleware<unknown, unknown, unknown>[];
}

// ============================================================================
// Error taxonomy
// ============================================================================

/**
 * Tagged-union errors emitted by the compiler harness. Carried as
 * rejection values; the `BaseHarness` wraps these into the
 * `terminal:failed` envelope.
 */
/** Migrated to class hierarchy (ADR 41). Re-exports from `../errors/harnesses.js`. */
export {
  AlreadyMounted,
  BridgeUnavailable,
  DataFetchFailed,
  FormatterFailed,
  InvalidElement,
  MaxIterationsExceeded,
  NotMounted,
  ReconcileError,
  type ReconcileErrorChannel,
  RenderFailed,
  UnstableTree,
} from "../errors/harnesses.js";

// ============================================================================
// Inbox messages
// ============================================================================

/**
 * Canonical inbox message types the compiler harness accepts at its
 * `compiler:{mountId}` address.
 *
 * - `recompile`  request a fresh `renderTree`. Used when an external
 *                signal (knob change, subscription fire, devtools) needs
 *                to push a re-render.
 * - `unmount`    tear down the mount.
 * - `invalidate` invalidate cached data; optionally narrow to specific
 *                keys or tags.
 *
 * Additional message types MAY be defined as the harness evolves —
 * unknown types route to the default `HandlerError` path.
 */
export type CompilerInboxMessage =
  | { readonly type: "recompile"; readonly mountId: string; readonly reason?: string }
  | { readonly type: "unmount"; readonly mountId: string }
  | {
      readonly type: "invalidate";
      readonly mountId: string;
      readonly keys?: readonly string[];
      readonly tags?: readonly string[];
    };

// ============================================================================
// The protocol
// ============================================================================

/**
 * Methods every compiler harness implementation MUST provide. All
 * methods reject with values matching `ReconcileError` (wrapped in a
 * tagged-union shape).
 */
/**
 * The compiler's **canonical** composable surface: the Effect twin of
 * `renderTree` (ADR 77, the dual-typed edge). The loop reaches
 * `compiler.fx.renderTree(...)` to compose the render into one fiber
 * tree (Stage 3); the plain Promise method on {@link CompilerProtocol}
 * is the derived edge facade ({@link PromiseView} of this),
 * `runHarnessProtocol` at the boundary.
 *
 * `renderTree` is not a registry command (it builds its Operation inline),
 * so `.fx` hand-exposes the `runOperation(op, body)` Effect the harness
 * already builds. The `E` channel is the compiler's own taxonomy
 * (`NotMounted`, `RenderFailed`, …) plus `SubstrateError`; the reference
 * callback compiler (whose render is an adopter `Effect.promise`) only
 * inhabits the substrate slice.
 */
export interface CompilerFx extends HarnessFx {
  /**
   * Reconcile-then-collect. The canonical command — produces a
   * `RenderedTree` ready for the executor harness to consume.
   */
  renderTree(
    input: RenderTreeInput,
  ): Effect.Effect<RenderTreeResult, ReconcileErrorChannel | SubstrateError, never>;
}

export interface CompilerProtocol extends PromiseView<Omit<CompilerFx, keyof HarnessFx>> {
  /**
   * The Effect-canonical composable surface (ADR 77) — `fx.renderTree` for
   * in-fiber composition by the loop. On the protocol so a protocol-typed
   * ref (the loop's `RunExecutionInput.compiler`) composes without
   * severing the fiber at the Promise facade.
   */
  readonly fx: CompilerFx;

  /**
   * Mount an application. Idempotent on `mountId` — calling twice with
   * the same `mountId` returns the existing mount (no re-execution).
   */
  mount(input: MountInput): Promise<MountResult>;

  /**
   * Replace the root element for a mounted application. Preserves
   * hook state where component identity is preserved.
   */
  rerender(input: RerenderInput): Promise<void>;

  // `renderTree` is derived from `PromiseView<Omit<CompilerFx, "use">>` — the Promise
  // facade of the Effect-canonical {@link CompilerFx.renderTree} twin.
  // The concrete harness exposes the Effect surface as `compiler.fx`.

  /**
   * Free-root render to a text payload. Used outside the tick loop
   * (e.g., a `renderToString` CLI / API endpoint that doesn't need a
   * full execution).
   */
  renderToString(input: RenderToStringInput): Promise<RenderToStringResult>;

  // Lifecycle is NOT a protocol obligation (ADR 89 §4): a compiler that
  // projects the command-hook lifecycle into in-tree hooks implements
  // the OPTIONAL {@link LifecycleProjectionTarget} capability; the
  // session feature-detects it and wires the forwarders.

  /**
   * Tear down a mount. Releases hook state and subscription handles.
   */
  unmount(input: UnmountInput): Promise<void>;
}

// ============================================================================
// CompilerFactory — deferred construction with shared substrate
// ============================================================================

export interface CompilerFactoryDeps {
  /**
   * The host's interceptor cascade, in the SAME nested shape a
   * {@link InstallerInterceptors} handle takes — so `inheritedFrom(deps)` from
   * `@agentick/runtime` spreads it straight into your harness options.
   *
   * Absent before this existed, which meant a factory-built compiler received
   * no app hooks, no guards, and no telemetry enrichment — silently, since it
   * still rendered. `onBefore/AfterCompilerRenderTree` declared on an app
   * simply never fired.
   */
  readonly interceptors?: InstallerInterceptors;
  readonly scopeId: string;
  readonly journal: import("./journal.js").OperationJournal;
  readonly bus: import("./bus.js").EventBus;
  readonly inbox: import("./inbox.js").MessageInbox;
}

/**
 * Deferred-construction form of `CompilerProtocol`. Used by
 * `defineCompiler(...)` so the parent harness can call the factory
 * with the shared substrate.
 *
 * `deps` is OPTIONAL: a parent harness passes its substrate so the compiler's
 * events flow on the shared bus/journal, while a STANDALONE caller (a test, a
 * REPL, an adopter probing their callbacks before wiring an app) calls the
 * factory bare and gets a private local substrate. Same convention as
 * {@link ExecutorFactory}.
 *
 * Marker symbol `compilerFactory` disambiguates a factory from a
 * pre-constructed instance.
 */
export interface CompilerFactory {
  readonly compilerFactory: true;
  (deps?: CompilerFactoryDeps): CompilerProtocol;
}

/** Type guard. */
export function isCompilerFactory(v: unknown): v is CompilerFactory {
  return typeof v === "function" && (v as { compilerFactory?: unknown }).compilerFactory === true;
}
