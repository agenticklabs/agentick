/**
 * In-memory `ToolRegistry` reference implementation.
 *
 * **Multi-binding storage.** Each registered name can have several
 * registrations live simultaneously — one per layered config seam
 * (gateway, app, session, execution, extension, compiler, runtime).
 * Per-tick precedence resolution happens in {@link InMemoryToolRegistry.compileForTick}:
 * for a given name, the highest-specificity binding's declaration wins.
 *
 * **Idempotency** is per binding key, not per name. Re-registering the
 * same shape (declaration + handlerRef + useDeps) under the same
 * binding is a no-op. Re-registering a DIFFERENT shape under the same
 * binding throws `ToolAlreadyRegistered`. Registering the same name
 * under a DIFFERENT binding just adds a sibling entry.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md §Tool registry
 */

import type {
  ToolBinding,
  ToolDeclaration,
  ToolExposure,
  ToolListFilter,
  ToolRegistration,
} from "@agentick/spec-next";
import { ToolAlreadyRegistered } from "@agentick/spec-next";
import { isEqual } from "@agentick/utils-next";

export class InMemoryToolRegistry {
  // name → array of registrations, one per distinct binding slot.
  // The array is kept short — at most one entry per layered seam.
  private readonly byName = new Map<string, ToolRegistration[]>();

  // alias → canonical tool name. Built from `declaration.aliases` at
  // register time so {@link get} resolves a dispatch by exact name first,
  // then O(1) by alias (mirroring v1's name-then-alias resolution).
  // Maintained incrementally on `add`; fully rebuilt on removal (rare).
  private readonly aliasToName = new Map<string, string>();

  /**
   * Add a registration. Idempotent on equal shape under the same
   * binding; throws `ToolAlreadyRegistered` when re-adding a different
   * shape to the same binding slot. Adds a sibling entry when the
   * binding slot is new for this name.
   */
  add(registration: ToolRegistration): void {
    const name = registration.declaration.name;
    const list = this.byName.get(name);
    if (!list) {
      this.byName.set(name, [registration]);
      this.indexAliases(registration);
      return;
    }
    const idx = list.findIndex((r) => sameBindingKey(r.binding, registration.binding));
    if (idx >= 0) {
      if (areRegistrationsEqual(list[idx]!, registration)) {
        return; // idempotent on identical shape
      }
      throw new ToolAlreadyRegistered({ name });
    }
    list.push(registration);
    this.indexAliases(registration);
  }

  /** Register this registration's declared aliases → its canonical name. */
  private indexAliases(registration: ToolRegistration): void {
    const name = registration.declaration.name;
    for (const alias of registration.declaration.aliases ?? []) {
      this.aliasToName.set(alias, name);
    }
  }

  /**
   * Full rebuild of the alias→name index from the current `byName` state.
   * Called after removals (which are rare relative to `get`); `add` keeps
   * the index up to date incrementally via {@link indexAliases}.
   */
  private reindexAliases(): void {
    this.aliasToName.clear();
    for (const list of this.byName.values()) {
      for (const reg of list) this.indexAliases(reg);
    }
  }

  /**
   * Remove EVERY registration for `name` (across all binding slots).
   * For scope-bounded removal use {@link removeWhere}.
   */
  remove(name: string): void {
    this.byName.delete(name);
    this.reindexAliases();
  }

  /**
   * Bulk-remove every registration whose binding matches `predicate`.
   * Used by lifecycle hooks — e.g., when a session closes the harness
   * calls `removeWhere(b => b.scope === "session" && b.sessionId === id)`
   * to clear that session's slice without touching app/gateway/runtime
   * registrations. Returns the COUNT of registrations removed (0 = no-op).
   */
  removeWhere(predicate: (binding: ToolBinding) => boolean): number {
    let removed = 0;
    for (const [name, list] of this.byName) {
      const kept = list.filter((r) => !predicate(r.binding));
      removed += list.length - kept.length;
      if (kept.length === 0) {
        this.byName.delete(name);
      } else if (kept.length !== list.length) {
        this.byName.set(name, kept);
      }
    }
    if (removed > 0) this.reindexAliases();
    return removed;
  }

  /**
   * Return the **highest-precedence** registration for `name`, or
   * `undefined`. Used by the dispatch path — the dispatched handler
   * matches the one the model saw via {@link compileForTick}.
   */
  get(name: string): ToolRegistration | undefined {
    const list = this.byName.get(name);
    if (!list || list.length === 0) {
      // Exact-name miss — fall back to an alias. The index maps
      // alias → canonical name; recurse once into the resolved name
      // (the alias necessarily differs from a registered name, so no
      // loop). Exact-name lookup above always wins over an alias.
      const canonical = this.aliasToName.get(name);
      return canonical !== undefined && canonical !== name ? this.get(canonical) : undefined;
    }
    let best = list[0]!;
    let bestRank = precedenceOf(best.binding);
    for (let i = 1; i < list.length; i++) {
      const cur = list[i]!;
      const r = precedenceOf(cur.binding);
      if (r > bestRank) {
        best = cur;
        bestRank = r;
      }
    }
    return best;
  }

  /** True if at least one binding registers this name. */
  has(name: string): boolean {
    const list = this.byName.get(name);
    return list !== undefined && list.length > 0;
  }

  /**
   * Snapshot the registered declarations — **one entry per
   * `(name, binding)` pair**. If the same name is registered under
   * multiple bindings (e.g., once at session scope and once via
   * the compiler), `list` returns both.
   *
   * For the per-tick precedence-resolved set the model should see at
   * a tick, use {@link compileForTick}.
   */
  list(filter?: ToolListFilter): readonly ToolDeclaration[] {
    const out: ToolDeclaration[] = [];
    for (const list of this.byName.values()) {
      for (const reg of list) {
        if (filter === undefined || matchesFilter(reg.declaration, filter)) {
          out.push(reg.declaration);
        }
      }
    }
    return out;
  }

  /**
   * Per-tick compile — return the precedence-resolved set of tool
   * declarations.
   *
   * Resolution order:
   * 1. Filter every registration against `filter` (the common case:
   *    `{ exposure: "model" }`).
   * 2. Dedup by `declaration.name`. On collision, the highest-
   *    precedence binding wins. Precedence (low → high):
   *    `runtime < gateway < {app, extension@app} < {session,
   *    extension@session} < execution < compiler`.
   *
   * Iteration order is the insertion order of the *winning*
   * registration's name — i.e., the order in which the first
   * registration for that name was added. Adopters who care about
   * order sort by name in projection.
   */
  compileForTick(filter?: ToolListFilter): readonly ToolDeclaration[] {
    const out: ToolDeclaration[] = [];
    for (const list of this.byName.values()) {
      let best: ToolRegistration | undefined;
      let bestRank = -1;
      for (const reg of list) {
        if (filter !== undefined && !matchesFilter(reg.declaration, filter)) continue;
        const r = precedenceOf(reg.binding);
        if (r > bestRank) {
          best = reg;
          bestRank = r;
        }
      }
      if (best !== undefined) out.push(best.declaration);
    }
    return out;
  }

  /**
   * Atomically replace the compiler-bound slice for the given
   * `mountId`. Removes every existing
   * `binding.scope === "compiler" && binding.mountId === mountId`
   * entry first, then adds the supplied registrations. Other binding
   * slices are untouched.
   *
   * Every supplied registration MUST carry a matching
   * `{ scope: "compiler", mountId }` binding; throws otherwise.
   */
  replaceCompilerSlice(mountId: string, registrations: readonly ToolRegistration[]): void {
    // 1. Validate every registration up-front so a bad input doesn't
    //    leave the registry half-mutated.
    for (const reg of registrations) {
      if (reg.binding.scope !== "compiler" || reg.binding.mountId !== mountId) {
        throw new Error(
          `replaceCompilerSlice: registration "${reg.declaration.name}" has binding ` +
            `${JSON.stringify(reg.binding)} — expected { scope: "compiler", mountId: "${mountId}" }`,
        );
      }
    }
    // 2. Remove the existing slice.
    this.removeWhere((b) => b.scope === "compiler" && b.mountId === mountId);
    // 3. Add the new slice.
    for (const reg of registrations) {
      this.add(reg);
    }
  }

  /** Count of registered names (NOT registrations). */
  size(): number {
    return this.byName.size;
  }

  /** Count of registrations across every binding. */
  totalRegistrations(): number {
    let n = 0;
    for (const list of this.byName.values()) n += list.length;
    return n;
  }

  /** All registered tool names, sorted lexicographically. */
  names(): readonly string[] {
    return Array.from(this.byName.keys()).sort();
  }

  /** Drop every registration. Used on harness close. */
  clear(): void {
    this.byName.clear();
    this.aliasToName.clear();
  }
}

// ============================================================================
// Precedence + binding-key helpers
// ============================================================================

/**
 * Numeric precedence rank for a binding. Higher wins on name
 * collision. The ordering implements the layered config story:
 * gateway is the floor; compiler is the ceiling; extensions take
 * the precedence of the level at which they were installed.
 *
 * Exported (constants + function) so adopters reading the code see
 * the ladder as data rather than a switch buried in a helper.
 */
export const PRECEDENCE_RANK = {
  runtime: 0,
  gateway: 1,
  app: 2,
  session: 3,
  execution: 4,
  // A CLIENT-owned declarative slice — the wire twin of the compiler
  // slice — outranks the static session/execution config seams (a live
  // client's current declaration is the more specific, up-to-date source)
  // but stays BELOW the in-process rendered tree (`compiler`), which is
  // authoritative. Tunable — see the {@link ToolBinding} docblock.
  client: 5,
  compiler: 6,
} as const satisfies Record<Exclude<ToolBinding["scope"], "extension">, number>;

export function precedenceOf(binding: ToolBinding): number {
  return binding.scope === "extension"
    ? PRECEDENCE_RANK[binding.level]
    : PRECEDENCE_RANK[binding.scope];
}

/**
 * Stable string key uniquely identifying a binding slot. The
 * serialization format DOCUMENTS the identity-defining fields per
 * variant — adding a non-identity field to a binding (telemetry
 * timestamp, etc.) MUST NOT change this key, so the format is the
 * authoritative answer to "what makes binding X the same slot as
 * binding Y."
 *
 * Used by {@link sameBindingKey} for `add()`'s "same slot? then
 * idempotency-check; else sibling" path. Suitable for a `Map` key
 * too — future refactor could nest registry storage as
 * `Map<name, Map<bindingKey, ToolRegistration>>` for O(1) slot
 * lookup, replacing the current linear scan of the inner array.
 */
export function bindingKey(b: ToolBinding): string {
  switch (b.scope) {
    case "runtime":
    case "gateway":
      return b.scope;
    case "app":
      return `app:${b.appId}`;
    case "session":
      return `session:${b.sessionId}`;
    case "execution":
      return `execution:${b.executionId}`;
    case "client":
      return `client:${b.sessionId}`;
    case "compiler":
      return `compiler:${b.mountId}`;
    case "extension":
      return `extension:${b.extensionName}:${b.level}`;
  }
}

/**
 * Two bindings refer to the same registry slot when their
 * {@link bindingKey} serializations are equal. Cheap string compare;
 * the per-variant identity contract lives in `bindingKey`.
 */
export function sameBindingKey(a: ToolBinding, b: ToolBinding): boolean {
  return bindingKey(a) === bindingKey(b);
}

// ============================================================================
// Filter + equality helpers
// ============================================================================

function matchesFilter(decl: ToolDeclaration, filter: ToolListFilter): boolean {
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
 * Structural equality for tool registrations — sufficient for
 * idempotency detection. Compares declaration, handlerRef, and useDeps.
 * Bindings are compared via {@link sameBindingKey} at the call site;
 * equality here is for the shape held in the same slot.
 */
function areRegistrationsEqual(a: ToolRegistration, b: ToolRegistration): boolean {
  return (
    isEqual(a.declaration, b.declaration) &&
    a.handlerRef === b.handlerRef &&
    isEqual(a.useDeps ?? {}, b.useDeps ?? {})
  );
}
