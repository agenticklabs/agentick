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

/**
 * Snapshot of harness-private state for a single mount.
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
  /** Per-component hook state, keyed by stable component path. */
  readonly hookStates: readonly HookStateEntry[];
  /** Cached results of `useData` calls. */
  readonly dataCache: readonly DataCacheEntry[];
  /** Current values of model-visible `useKnob` state. */
  readonly knobs: Readonly<Record<string, unknown>>;
  /** Long-lived primitive intent declarations (cron, webhook, …). */
  readonly subscriptions: readonly SubscriptionIntent[];
  /** Free-form metadata for future extensibility. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * One captured hook state slot. Indexed by `(componentPath, hookIndex)`
 * — the same scheme React uses internally to associate hook slots with
 * a component instance.
 */
export interface HookStateEntry {
  /** Deterministic component path identifier (stable across rerenders). */
  readonly path: string;
  /** Position of the hook within the component's hook list. */
  readonly hookIndex: number;
  readonly type: HookType;
  readonly value: unknown;
}

/**
 * Captured hook varieties. Open list to allow new hook types to add
 * snapshot capture without breaking older snapshots.
 */
export type HookType =
  | "state"
  | "reducer"
  | "ref"
  | "memo"
  | "callback"
  | "knob"
  | "data"
  | "signal"
  | (string & {});

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
 * - `max-iterations`         the render-until-stable loop hit its cap
 * - `use-data-failed`        a `useData` fetcher rejected during render
 * - `missing-contributor`    no Contributor registered for a host node's type
 * - `missing-bridge`         a hook required a bridge the runtime did not supply
 * - `formatter-error`        the formatter harness failed on a sub-tree
 * - `render-error`           a component threw during render (caught at root)
 * - `snapshot-incompatible`  a restore() encountered a snapshot it could not apply
 * - `unstable-tree`          consecutive renders produced different output past the cap
 */
export type ReconcileDiagnosticCode =
  | "max-iterations"
  | "use-data-failed"
  | "missing-contributor"
  | "missing-bridge"
  | "formatter-error"
  | "render-error"
  | "snapshot-incompatible"
  | "unstable-tree"
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
// Free-root render output (renderToString / renderResource)
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
