/**
 * Compiler diagnostics + the declarative shapes the compiler surfaces
 * alongside a render: long-lived subscription intents and the free-root
 * `renderToString` payload.
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md
 */

import type { ContentBlock } from "./content-blocks.js";

/**
 * Long-lived intent declared by a JSX primitive (cron / webhook / event
 * listener / subscription). The runtime materializes these as actual
 * scheduled work; the declaration regenerates by re-render at mount.
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
 * Severity / classification of a compiler diagnostic.
 *
 * Diagnostics surface non-fatal issues — fatal errors flow through the
 * operation's `terminal:failed` outcome. A `renderTree` result with
 * `error`-severity diagnostics is one where the tree was produced but
 * carries known defects (e.g., an unknown component was skipped).
 */
export type ReconcileDiagnosticSeverity = "info" | "warning" | "error";

/**
 * Compiler-specific diagnostic codes. Open list — implementations
 * MAY surface additional codes.
 *
 * - `max-iterations`            the render-until-stable loop hit its cap
 * - `use-data-failed`           a `useData` fetcher rejected during render
 * - `missing-contributor`       no Contributor registered for a host node's type
 * - `missing-bridge`            a hook required a bridge the runtime did not supply
 * - `formatter-error`           the formatter harness failed on a sub-tree
 * - `render-error`              a component threw during render (caught at root)
 * - `unstable-tree`             consecutive renders produced different output past the cap
 * - `error-boundary-active`     an `<ErrorBoundary>` caught a render error and
 *                               rendered a fallback into the IR (info severity)
 * - `await-timeout`             the render-until-stable loop's `awaitTimeoutMs`
 *                               budget elapsed before an iteration's `useData`
 *                               fetchers resolved
 *
 * (ADR 63 retired `timeline-not-rendered`: the timeline now surfaces via a
 * default projection when no `<Timeline>` overrides it, so a conversation
 * can no longer be silently dropped by omitting the component.)
 */
export type ReconcileDiagnosticCode =
  | "max-iterations"
  | "await-timeout"
  | "use-data-failed"
  | "missing-contributor"
  | "missing-bridge"
  | "formatter-error"
  | "render-error"
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
