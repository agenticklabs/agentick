/**
 * In-memory `ToolRegistry` reference implementation.
 *
 * Keyed by `declaration.name`. `add` is idempotent for an identical
 * registration (deep-equal shape on `declaration` + `handlerRef` +
 * `useDeps`) and throws `ToolAlreadyRegistered` on conflict — callers
 * who want last-writer-wins should `remove` first.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md §Tool registry
 */

import type {
  ToolDeclaration,
  ToolExposure,
  ToolListFilter,
  ToolRegistration,
} from "@agentick/spec";

export class InMemoryToolRegistry {
  private readonly byName = new Map<string, ToolRegistration>();

  /**
   * Add a registration. Idempotent on equal shape; throws
   * `ToolAlreadyRegistered` (as a tagged-union rejection) on conflict.
   *
   * Surfaced via the harness's `register()` command. Direct callers
   * (tests, hot-paths) may invoke this method directly.
   */
  add(registration: ToolRegistration): void {
    const name = registration.declaration.name;
    const existing = this.byName.get(name);
    if (existing) {
      if (areRegistrationsEqual(existing, registration)) {
        return; // idempotent on identical shape
      }
      throw { _tag: "ToolAlreadyRegistered", name } as const;
    }
    this.byName.set(name, registration);
  }

  /** Remove by name. No-op for unknown names. */
  remove(name: string): void {
    this.byName.delete(name);
  }

  /** Return the registration for a name, or `undefined`. */
  get(name: string): ToolRegistration | undefined {
    return this.byName.get(name);
  }

  /** True if a tool is registered under this name. */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Snapshot the current set of declarations, optionally filtered.
   */
  list(filter?: ToolListFilter): readonly ToolDeclaration[] {
    const all = Array.from(this.byName.values(), (r) => r.declaration);
    if (!filter) return all;
    return all.filter((d) => matches(d, filter));
  }

  /** Current count — useful for tests + diagnostics. */
  size(): number {
    return this.byName.size;
  }

  /** All registered tool names, sorted lexicographically. */
  names(): readonly string[] {
    return Array.from(this.byName.keys()).sort();
  }

  /** Drop every registration. Used on harness close. */
  clear(): void {
    this.byName.clear();
  }
}

// ============================================================================
// Helpers
// ============================================================================

function matches(decl: ToolDeclaration, filter: ToolListFilter): boolean {
  if (filter.exposure !== undefined) {
    if (!decl.exposure.includes(filter.exposure as ToolExposure)) return false;
  }
  if (filter.intent !== undefined) {
    if (decl.annotations?.intent !== filter.intent) return false;
  }
  if (filter.nameMatches !== undefined) {
    const re = new RegExp(filter.nameMatches);
    if (!re.test(decl.name)) return false;
  }
  return true;
}

/**
 * Deep structural equality for tool registrations — sufficient for
 * idempotency detection. Compares declaration, handlerRef, and useDeps
 * via JSON shape. Both sides are JSON-firewall-safe by construction.
 */
function areRegistrationsEqual(a: ToolRegistration, b: ToolRegistration): boolean {
  return (
    jsonEqual(a.declaration, b.declaration) &&
    a.handlerRef === b.handlerRef &&
    jsonEqual(a.useDeps ?? {}, b.useDeps ?? {})
  );
}

function jsonEqual(a: unknown, b: unknown): boolean {
  // Cheap-but-correct: stringify and compare. The values flowing through
  // the registry are JSON-shaped by the spec firewall, so this is
  // canonical for our purposes.
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
