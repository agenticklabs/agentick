/**
 * Reconciler snapshot and diagnostics.
 *
 * `ReconcilerSnapshot` is the harness-private state needed to rehydrate
 * a mounted application after hibernation or process restart. It is
 * JSON-shaped: it MUST survive `JSON.parse(JSON.stringify(s))` without
 * losing information.
 *
 * The host tree (mutable `HostInstance`s) is NOT snapshotted — it is
 * re-derived by reconciling the root element after restore.
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md §Snapshot / restore
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md §Snapshot rules
 */

import type { ContentBlock } from "./content-blocks.js";
import type { HookBridges, SnapshotCapable } from "../protocol/hook-bridges.js";

/**
 * Snapshot of harness-private state for a single mount.
 *
 * **Per ADR 27 (modular built-ins):** harness state is captured in the
 * generic `bridges` map, keyed by `HookBridges` slot names. The
 * reconciler iterates `Object.entries(bridges)` and feature-tests each
 * slot for the `SnapshotCapable` contract — no harness-specific
 * knowledge lives in the reconciler. New harness packages register
 * their `HookBridges` slot via TypeScript module augmentation and
 * extend `SnapshotCapable<T>` on their protocol; the snapshot map type
 * picks them up automatically via the mapped-type inference below.
 *
 * `dataCache` and `subscriptions` retain their own top-level fields
 * because they're not 1:1 mappings of a single bridge's state — they
 * represent reconciler-internal concerns that incidentally LIVE in
 * bridge state. `subscriptions` will move to its own bridge slot
 * (via the subscriptions harness) in a later pass.
 */
export interface ReconcilerSnapshot {
  /** Spec date version. Compatibility check at restore time. */
  readonly specVersion: string;
  /** Stable mount identifier the snapshot was captured for. */
  readonly mountId: string;
  /**
   * Optional hash / version of the root element source. When the runtime
   * remounts with a different element version, the restore MAY discard
   * the snapshot (or surface an `IncompatibleElement` diagnostic).
   */
  readonly elementVersion?: string;
  /**
   * Per-bridge snapshot payloads, keyed by `HookBridges` slot name.
   * Only slots whose protocol extends `SnapshotCapable<T>` (timeline,
   * knobs, state, ...) populate here at typecheck time; runtime
   * feature-detection picks up impls that happen to have
   * `exportSnapshot` even if their protocol doesn't formally declare
   * it (e.g., `InMemoryDataBridge`).
   *
   * Adding a new harness with snapshot support requires zero reconciler
   * changes — the harness extends `SnapshotCapable<T>` and augments
   * `HookBridges` from its own package; the type + runtime pick it up
   * automatically.
   */
  readonly bridges: Readonly<{
    [K in keyof HookBridges]?: HookBridges[K] extends SnapshotCapable<infer S> ? S : unknown;
  }>;
  /**
   * Cached results of `useData` calls. Kept as a top-level field for
   * back-compat with InMemoryDataBridge's snapshot shape; future
   * versions may collapse this into `bridges.data` if DataBridge's
   * protocol formally extends SnapshotCapable.
   */
  readonly dataCache: readonly DataCacheEntry[];
  /** Long-lived primitive intent declarations (cron, webhook, …). */
  readonly subscriptions: readonly SubscriptionIntent[];
  /** Free-form metadata for future extensibility. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * One cached `useData` result.
 */
export interface DataCacheEntry {
  readonly key: string;
  readonly value: unknown;
  /** Epoch ms when the value was fetched. */
  readonly fetchedAt: number;
  /** Optional TTL the fetcher declared. */
  readonly ttl?: number;
  /** Optional invalidation tag declared by the fetcher. */
  readonly tag?: string;
}

/**
 * Long-lived intent declared by a JSX primitive (cron / webhook / event
 * listener / subscription). The runtime materializes these as actual
 * scheduled work; the snapshot records *what was declared* so a
 * restored harness can re-declare the same intents.
 */
export interface SubscriptionIntent {
  readonly id: string;
  /** Discriminator: `cron`, `webhook`, `event`, `subscription`, … */
  readonly kind: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Diagnostics
// ============================================================================

/**
 * Severity / classification of a reconciler diagnostic.
 *
 * Diagnostics surface non-fatal issues — fatal errors flow through the
 * operation's `terminal:failed` outcome. A `renderTree` result with
 * `error`-severity diagnostics is one where the tree was produced but
 * carries known defects (e.g., an unknown component was skipped).
 */
export type ReconcileDiagnosticSeverity = "info" | "warning" | "error";

/**
 * Reconciler-specific diagnostic codes. Open list — implementations
 * MAY surface additional codes.
 *
 * - `max-iterations`            the render-until-stable loop hit its cap
 * - `use-data-failed`           a `useData` fetcher rejected during render
 * - `missing-contributor`       no Contributor registered for a host node's type
 * - `missing-bridge`            a hook required a bridge the runtime did not supply
 * - `formatter-error`           the formatter harness failed on a sub-tree
 * - `render-error`              a component threw during render (caught at root)
 * - `snapshot-incompatible`     a restore() encountered a snapshot it could not apply
 * - `unstable-tree`             consecutive renders produced different output past the cap
 * - `error-boundary-active`     an `<ErrorBoundary>` caught a render error and
 *                               rendered a fallback into the IR (info severity)
 * - `await-timeout`             the render-until-stable loop's `awaitTimeoutMs`
 *                               budget elapsed before an iteration's `useData`
 *                               fetchers resolved
 */
export type ReconcileDiagnosticCode =
  | "max-iterations"
  | "await-timeout"
  | "use-data-failed"
  | "missing-contributor"
  | "missing-bridge"
  | "formatter-error"
  | "render-error"
  | "snapshot-incompatible"
  | "unstable-tree"
  | "error-boundary-active"
  | (string & {});

/**
 * Diagnostic emitted during reconcile or collect.
 */
export interface ReconcileDiagnostic {
  readonly severity: ReconcileDiagnosticSeverity;
  readonly code: ReconcileDiagnosticCode;
  readonly message: string;
  /** Component path (when applicable). */
  readonly path?: string;
  /** Captured error (`message`/`name`/`stack`) when applicable. */
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
  /** Free-form structured context. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Free-root render output (renderToString)
// ============================================================================

/**
 * Result of a free-root `renderToString` call. Carries text + content
 * blocks + mime hint. Distinct from `RenderedTree` because the caller
 * is asking for content, not an IR.
 */
export interface RenderToStringPayload {
  readonly text: string;
  readonly mimeType: string;
  readonly content?: readonly ContentBlock[];
}
