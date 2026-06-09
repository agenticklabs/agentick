/**
 * HostScope — lexically inherited state flowing through
 * `getChildHostContext`.
 *
 * v1 used a module-level `Map<unknown, Renderer>` (`RENDERER_COMPONENTS`)
 * to track which component types swap the formatter. That violates the
 * spec firewall (multi-tenant servers cannot isolate registries per
 * mount). v2 binds formatter scope to the host context itself —
 * immutable, lexically scoped, replaced at scope boundaries.
 *
 * Components that switch the formatter (a `<Markdown>` / `<XML>`
 * provider) do so by declaring in their props what binding they impose
 * on descendants. The host config reads those props in
 * `getChildHostContext` and produces a new `HostScope` via
 * `withFormatter` for the subtree.
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md §Layer A
 */

import type { FormatPurpose, FormatterRef } from "@agentick/spec-next";

/**
 * Formatter binding for a host scope. Lookups by `purpose` (e.g.,
 * `"message"`, `"section"`, `"free-root"`) fall back to `default`
 * when no purpose-specific binding exists.
 */
export interface FormatterScope {
  readonly default: FormatterRef;
  readonly byPurpose?: Readonly<Partial<Record<FormatPurpose, FormatterRef>>>;
}

/**
 * Single binding pair. Used as the argument to `withFormatter`.
 */
export interface FormatterBinding {
  readonly formatter: FormatterRef;
  /** Bind for one purpose. If absent, replaces the scope's default. */
  readonly purpose?: FormatPurpose;
}

/**
 * Immutable scope record. Replaced (never mutated) at scope boundaries.
 * Carried on every `ElementInstance` (captured from
 * `getChildHostContext` at create-time).
 */
export interface HostScope {
  readonly formatters: FormatterScope;
  /**
   * Lexical ancestry chain of stable identifiers (typically section ids
   * or component names). Used by collectors to derive stable entry ids.
   */
  readonly path: readonly string[];
}

/**
 * Create a fresh scope. Typically called by the Container creator to
 * seed the root scope.
 */
export function createHostScope(input: {
  readonly formatter: FormatterRef;
  readonly path?: readonly string[];
}): HostScope {
  return {
    formatters: { default: input.formatter },
    path: input.path ?? [],
  };
}

/**
 * The default scope used by containers that don't specify their own
 * formatter. The default formatter id is `"default"` — the runtime is
 * expected to resolve this to a concrete formatter via the formatter
 * harness's registry.
 */
export const rootScope: HostScope = Object.freeze({
  formatters: Object.freeze({ default: Object.freeze({ id: "default" }) }) as FormatterScope,
  path: Object.freeze([]) as readonly string[],
});

/**
 * Produce a new scope with `binding` applied. The original scope is not
 * mutated. Path-only changes go through `withPath`.
 */
export function withFormatter(scope: HostScope, binding: FormatterBinding): HostScope {
  if (binding.purpose) {
    return {
      formatters: {
        default: scope.formatters.default,
        byPurpose: {
          ...scope.formatters.byPurpose,
          [binding.purpose]: binding.formatter,
        },
      },
      path: scope.path,
    };
  }
  return {
    formatters: { ...scope.formatters, default: binding.formatter },
    path: scope.path,
  };
}

/**
 * Extend the lexical path by one segment. Returns a new scope.
 */
export function withPath(scope: HostScope, segment: string): HostScope {
  return {
    formatters: scope.formatters,
    path: [...scope.path, segment],
  };
}

/**
 * Resolve the formatter for a given purpose. Falls back to
 * `formatters.default` when no purpose-specific binding exists.
 */
export function resolveFormatter(scope: HostScope, purpose?: FormatPurpose): FormatterRef {
  if (purpose) {
    const specific = scope.formatters.byPurpose?.[purpose];
    if (specific) return specific;
  }
  return scope.formatters.default;
}
