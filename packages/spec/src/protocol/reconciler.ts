/**
 * ReconcilerProtocol — the contract every reconciler harness
 * implementation satisfies.
 *
 * The reference implementation is `@agentick/reconciler-react` (Phase 3),
 * which uses `react-reconciler` to drive a JSX tree. Future
 * implementations on alternative substrates (imperative builders,
 * Vue/Solid hosts, …) MUST satisfy the same contract and pass
 * `runReconcilerConformance`.
 *
 * ## Design constraints baked into this protocol
 *
 * - **No Suspense.** Implementations MUST NOT surface "loading" states
 *   in the produced `RenderedTree`. The render-until-stable loop
 *   blocks on async data resolution (see `DataBridge`) and only emits
 *   a terminal result when the tree is fully resolved — or terminates
 *   with `outcome: "failed"` when resolution cannot complete.
 * - **JSON-shaped output.** `RenderedTree`, `ReconcilerSnapshot`, and
 *   `RenderToStringPayload` cross the spec firewall — no function
 *   references, no live SDK clients.
 * - **Bridges, not globals.** Implementations consume `HookBridges`
 *   provided at mount time. Module-level singletons are forbidden.
 * - **Sync render flush.** Implementations SHOULD reconcile
 *   synchronously to completion (or to a thrown data Promise) on each
 *   loop iteration. React's concurrent / time-slicing modes are out of
 *   scope.
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

import type { ContentBlock, FormatterRef, RenderedTree } from "../data/index.js";
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
// renderToString — free-root rendering to a string
// ============================================================================

export interface RenderToStringInput extends MountScopedInput {
  /** Query string the application uses to select what to render. */
  readonly query: string;
  /** Override the in-scope formatter for this render. */
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
// renderResource — free-root rendering of a declared resource
// ============================================================================

export interface RenderResourceInput extends MountScopedInput {
  /** Resource id matching a `ResourceDeclaration.id` in the tree. */
  readonly resourceId: string;
  readonly formatter?: FormatterRef;
  readonly maxIterations?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RenderResourceResult {
  readonly content: readonly ContentBlock[];
  readonly text?: string;
  readonly mimeType?: string;
  readonly diagnostics: readonly ReconcileDiagnostic[];
  readonly iterations: number;
}

// ============================================================================
// notifyTickEnd
// ============================================================================

/**
 * Loose-coupling notification: the loop executor finished a tick and is
 * informing the reconciler so any registered `useOnTickEnd` callbacks
 * can fire. Direct in-process call; the alternative pattern is for the
 * reconciler harness to subscribe to the loop's tickEnd lifecycle.
 *
 * The `tickResult` payload is JSON-shaped — its concrete shape is
 * specified in the loop executor's protocol.
 */
export interface NotifyTickEndInput extends MountScopedInput {
  readonly tickResult: unknown;
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
  | { readonly _tag: "MaxIterationsExceeded"; readonly iterations: number; readonly reason?: string }
  | { readonly _tag: "UnstableTree"; readonly iterations: number }
  | { readonly _tag: "InvalidElement"; readonly reason: string }
  | { readonly _tag: "SnapshotIncompatible"; readonly specVersion: string; readonly reason?: string }
  | { readonly _tag: "BridgeUnavailable"; readonly bridge: string; readonly hook: string }
  | { readonly _tag: "FormatterFailed"; readonly cause: unknown }
  | { readonly _tag: "ResourceNotFound"; readonly resourceId: string };

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
   * Free-root render of a declared resource by id.
   */
  renderResource(input: RenderResourceInput): Promise<RenderResourceResult>;

  /**
   * Notify the reconciler that a tick has ended. Fires any registered
   * `useOnTickEnd` callbacks inside the mount. The runtime calls this
   * after the loop executor's tick `terminal` event.
   */
  notifyTickEnd(input: NotifyTickEndInput): Promise<void>;

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
