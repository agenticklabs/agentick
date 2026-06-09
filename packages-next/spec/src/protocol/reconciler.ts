/**
 * ReconcilerProtocol — the contract every reconciler harness
 * implementation satisfies.
 *
 * The reference implementation is `@agentick/reconciler-react-next` (Phase 3),
 * which uses `react-reconciler` to drive a JSX tree. Future
 * implementations on alternative substrates (imperative builders,
 * Vue/Solid hosts, …) MUST satisfy the same contract and pass
 * `runReconcilerConformance`.
 *
 * ## Design constraints baked into this protocol
 *
 * - **Fully-resolved IR.** `RenderedTree` reflects a fully-resolved
 *   component tree. The render-until-stable loop blocks on async
 *   `DataBridge.resolve` calls (Suspense primitive — thrown Promises)
 *   and only emits a terminal result when the tree is stable — or
 *   terminates with `outcome: "failed"` when resolution cannot
 *   complete.
 * - **React feature semantics:** the reconciler uses React's reconciler,
 *   component model, hooks, refs, effects, and context. The following
 *   React features have specific semantics:
 *     - `<Suspense fallback>` — allowed, but fallback content may
 *       appear in the IR if a boundary fires. The framework does NOT
 *       detect or guard against this — Suspense's catch-and-fallback
 *       behavior is React's native lifecycle and Reconciler harness
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
 *       allowed; no effect (the reconciler renders synchronously).
 *     - React Server Components — not supported.
 * - **JSON-shaped output.** `RenderedTree`, `ReconcilerSnapshot`, and
 *   `RenderToStringPayload` cross the spec firewall — no function
 *   references, no live SDK clients.
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

import type { FormatterRef, RenderedTree } from "../data/index.js";
import type {
  ReconcileDiagnostic,
  ReconcilerSnapshot,
  RenderToStringPayload,
} from "../data/reconciler-snapshot.js";
import type { HookBridges } from "./hook-bridges.js";

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
   * The React element (or equivalent for non-React reconcilers) to mount.
   * Opaque to the spec — the reference impl typecasts to
   * `React.ReactNode` internally.
   */
  readonly element: unknown;

  readonly sessionId: string;
  readonly executionId?: string;

  /** Runtime-supplied bridges. See `HookBridges`. */
  readonly bridges: HookBridges;

  /**
   * Initial formatter binding for the mount. The reconciler's host
   * context inherits from this root scope.
   */
  readonly defaultFormatter?: FormatterRef;

  /**
   * Optional snapshot to restore before the first render. When
   * supplied, the harness applies it before processing the first
   * `renderTree` call.
   */
  readonly snapshot?: ReconcilerSnapshot;

  /**
   * Optional element version hash. When the runtime later remounts
   * with a different `elementVersion`, the harness MAY discard a
   * supplied snapshot.
   */
  readonly elementVersion?: string;

  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MountResult {
  readonly mountId: string;
  /** True when a supplied snapshot was applied. */
  readonly restoredFromSnapshot: boolean;
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
 * not yet wired. When the formatter harness lands, the reconciler
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
// notifyLifecycle
// ============================================================================

/**
 * Lifecycle pass-through events. Carriers of state that user-supplied
 * hooks (`useOnTickStart`, `useOnTickEnd`, `useOnExecutionEnd`,
 * `useOnError`) need to observe.
 *
 * **Tagged union, open-ended.** New event kinds can be added without
 * changing the protocol method count. Implementations dispatch on
 * `event.kind`; unknown kinds are ignored (the harness MAY emit an
 * `info`-severity diagnostic for visibility).
 *
 * Two coupling axes coexist for these events:
 *
 *  - **Direct method-based coupling (this command).** Callers invoke
 *    `notifyLifecycle` synchronously when ordering matters — typically
 *    the session / loop executor calling into the reconciler before
 *    starting the next operation, so hook callbacks finish and React
 *    state settles in time.
 *  - **Bus-based fan-out (parallel channel).** The same lifecycle
 *    moments are independently emitted as `ProtocolEvent` envelopes on
 *    the shared event bus. Subscribers that don't need ordering
 *    (devtools, telemetry, persistence) observe via the bus without
 *    coupling to the reconciler protocol.
 *
 * The two channels are not redundant — they answer different questions.
 */
export type LifecycleEvent =
  | LifecycleTickStart
  | LifecycleTickEnd
  | LifecycleExecutionStart
  | LifecycleExecutionEnd
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
   * executor protocol. The reconciler forwards the value untouched to
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

export interface NotifyLifecycleInput extends MountScopedInput {
  readonly event: LifecycleEvent;
}

// ============================================================================
// snapshot / restore
// ============================================================================

export interface SnapshotInput extends MountScopedInput {}

export interface RestoreInput extends MountScopedInput {
  readonly snapshot: ReconcilerSnapshot;
  readonly elementVersion?: string;
}

// ============================================================================
// Error taxonomy
// ============================================================================

/**
 * Tagged-union errors emitted by the reconciler harness. Carried as
 * rejection values; the `BaseHarness` wraps these into the
 * `terminal:failed` envelope.
 */
export type ReconcileError =
  | { readonly _tag: "NotMounted"; readonly mountId: string }
  | { readonly _tag: "AlreadyMounted"; readonly mountId: string }
  | { readonly _tag: "RenderFailed"; readonly cause: unknown; readonly path?: string }
  | { readonly _tag: "DataFetchFailed"; readonly key: string; readonly cause: unknown }
  | {
      readonly _tag: "MaxIterationsExceeded";
      readonly iterations: number;
      readonly reason?: string;
    }
  | { readonly _tag: "UnstableTree"; readonly iterations: number }
  | { readonly _tag: "InvalidElement"; readonly reason: string }
  | {
      readonly _tag: "SnapshotIncompatible";
      readonly specVersion: string;
      readonly reason?: string;
    }
  | { readonly _tag: "BridgeUnavailable"; readonly bridge: string; readonly hook: string }
  | { readonly _tag: "FormatterFailed"; readonly cause: unknown };

// ============================================================================
// Inbox messages
// ============================================================================

/**
 * Canonical inbox message types the reconciler harness accepts at its
 * `reconciler:{mountId}` address.
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
export type ReconcilerInboxMessage =
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
 * Methods every reconciler harness implementation MUST provide. All
 * methods reject with values matching `ReconcileError` (wrapped in a
 * tagged-union shape).
 */
export interface ReconcilerProtocol {
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

  /**
   * Reconcile-then-collect. The canonical command — produces a
   * `RenderedTree` ready for the executor harness to consume.
   */
  renderTree(input: RenderTreeInput): Promise<RenderTreeResult>;

  /**
   * Free-root render to a text payload. Used outside the tick loop
   * (e.g., a `renderToString` CLI / API endpoint that doesn't need a
   * full execution).
   */
  renderToString(input: RenderToStringInput): Promise<RenderToStringResult>;

  /**
   * Lifecycle pass-through. Direct method-based coupling for events
   * that user hooks (`useOnTickStart`, `useOnTickEnd`,
   * `useOnExecutionEnd`, `useOnError`) need to observe synchronously
   * before the caller proceeds. See {@link LifecycleEvent} for kinds.
   *
   * Lifecycle moments are *also* emitted on the shared event bus for
   * fan-out observers (devtools, telemetry, persistence). The two
   * channels coexist by design.
   */
  notifyLifecycle(input: NotifyLifecycleInput): Promise<void>;

  /**
   * Tear down a mount. Releases hook state and subscription handles.
   */
  unmount(input: UnmountInput): Promise<void>;

  /**
   * Capture private state for hibernation / persistence.
   */
  snapshot(input: SnapshotInput): Promise<ReconcilerSnapshot>;

  /**
   * Restore private state from a prior snapshot. The next `renderTree`
   * call uses the restored state.
   */
  restore(input: RestoreInput): Promise<void>;
}

// ============================================================================
// ReconcilerFactory — deferred construction with shared substrate
// ============================================================================

export interface ReconcilerFactoryDeps {
  readonly scopeId: string;
  readonly journal: import("./journal.js").OperationJournal;
  readonly bus: import("./bus.js").EventBus;
  readonly inbox: import("./inbox.js").MessageInbox;
}

/**
 * Deferred-construction form of `ReconcilerProtocol`. Used by
 * `defineReconciler(...)` so the parent harness can call the factory
 * with the shared substrate.
 *
 * Marker symbol `reconcilerFactory` disambiguates a factory from a
 * pre-constructed instance.
 */
export interface ReconcilerFactory {
  readonly reconcilerFactory: true;
  (deps: ReconcilerFactoryDeps): ReconcilerProtocol;
}

/** Type guard. */
export function isReconcilerFactory(v: unknown): v is ReconcilerFactory {
  return (
    typeof v === "function" &&
    (v as { reconcilerFactory?: unknown }).reconcilerFactory === true
  );
}
