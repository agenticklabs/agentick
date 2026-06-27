/**
 * `WalkScope` — immutable formatter binding carried through a
 * compiler walker's recursion.
 *
 * Mirrors the semantics of `HostScope` in `@agentick/reconciler-next`:
 * each scope holds a `default` `FormatterRef` plus optional per-purpose
 * overrides. Children inherit the parent scope; the `<format>`
 * intrinsic produces a derived scope for its subtree via
 * `withFormatter(...)`.
 *
 * Lives in compiler-next so per-framework adapters (compiler-react,
 * future compiler-angular / compiler-solid) and the reactive harness
 * (reconciler-react) can all carry the same shape. Today only
 * compiler-react consumes it; the reconciler still uses its own
 * `HostScope` until ADR 39 Phase 3 step 3d consolidates the two.
 *
 * @see docs/proposals/v2/blueprint/39-jsx-template-walker.md
 */

import type { FormatPurpose, FormatterRef } from "@agentick/spec-next";

/**
 * Formatter binding map. `default` is the active formatter when no
 * purpose match is found; `byPurpose` lets `<format purpose="...">`
 * scope a swap to one entry kind (e.g., only sections).
 */
export interface FormatterScope {
  readonly default?: FormatterRef;
  readonly byPurpose?: Readonly<Partial<Record<FormatPurpose, FormatterRef>>>;
}

/**
 * Walker scope record. Immutable — `withFormatter(...)` returns a new
 * scope for descendant walks.
 */
export interface WalkScope {
  readonly formatters: FormatterScope;
}

export interface FormatterBinding {
  readonly formatter: FormatterRef;
  /** Bind for one purpose. If absent, replaces the scope's default. */
  readonly purpose?: FormatPurpose;
}

/**
 * Create a fresh scope. Optionally seed with a root formatter.
 */
export function createWalkScope(input?: { readonly formatter?: FormatterRef }): WalkScope {
  return {
    formatters: input?.formatter ? { default: input.formatter } : {},
  };
}

/**
 * Empty scope — no default formatter. Useful as a "no formatter scope
 * applied at compile time" seed; the consuming harness can stamp
 * entries with a runtime formatter ref after the walk if desired.
 */
export const EMPTY_WALK_SCOPE: WalkScope = createWalkScope();

/**
 * Produce a new scope with `binding` applied. The original scope is
 * not mutated.
 */
export function withFormatter(scope: WalkScope, binding: FormatterBinding): WalkScope {
  if (binding.purpose) {
    return {
      formatters: {
        default: scope.formatters.default,
        byPurpose: {
          ...scope.formatters.byPurpose,
          [binding.purpose]: binding.formatter,
        },
      },
    };
  }
  return {
    formatters: { ...scope.formatters, default: binding.formatter },
  };
}

/**
 * Resolve the formatter for a given purpose. Falls back to
 * `formatters.default`; returns `undefined` if neither is set.
 */
export function resolveFormatter(
  scope: WalkScope,
  purpose?: FormatPurpose,
): FormatterRef | undefined {
  if (purpose) {
    const specific = scope.formatters.byPurpose?.[purpose];
    if (specific) return specific;
  }
  return scope.formatters.default;
}
