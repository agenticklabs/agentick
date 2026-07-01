/**
 * `ToolCatalog` — a minimal mutable-source primitive for tool
 * declarations. Consumed by adopters (and framework projections like
 * the MCP server) that need to observe tool-set changes over time.
 *
 * ## Why this exists
 *
 * The MCP server projection today accepts a static
 * `readonly ToolDeclaration[]` — fine for adopters whose tool set is
 * fixed at construction. Adopters with mutable tool sources (e.g.,
 * conditional tools based on auth state, feature flags, or runtime
 * registration) need a way to (1) let the projection re-fetch on
 * every list request and (2) signal MCP clients to refetch via
 * `notifications/tools/list_changed`.
 *
 * `ToolCatalog` is the two-method interface (`list` + `subscribeAll`)
 * that satisfies both concerns. Static-array adopters continue to
 * work unchanged — the config accepts either an array OR a catalog.
 *
 * ## Overlap with prompts
 *
 * Structural, not code. `PromptsHarnessProtocol` (from
 * `@agentick/spec-next`) is a full harness with substrate + inbox +
 * lifecycle. Tools already have layered scope infrastructure
 * (session/app/gateway/extension) via the tool-executor; introducing
 * a full tools harness would collide with that infrastructure.
 *
 * `ToolCatalog` is deliberately smaller: just the two methods MCP
 * projection (and any similar "list + observe" consumer) needs. If
 * we ever get a third such catalog (resources — pending #123), we
 * can consider a generic `Catalog<T>` abstraction; until then, YAGNI.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md §MCP server projection
 */

import type { ToolDeclaration, Unsubscribe } from "@agentick/spec-next";
import { createNotifier } from "@agentick/pubsub-next";

/**
 * A mutable collection of tool declarations with change notifications.
 * Consumers (MCP server projection, future in-process observers) call
 * `list()` to enumerate and `subscribeAll(cb)` to observe changes.
 *
 * Concurrency: implementations decide their own thread-safety. The
 * simple in-memory implementation from {@link createToolCatalog} is
 * synchronous-only.
 */
export interface ToolCatalog {
  /**
   * Snapshot the current tool declarations. Called on every consumer
   * enumerate request — implementations should be O(n) or better.
   */
  list(): readonly ToolDeclaration[];

  /**
   * Register a listener fired on every catalog mutation
   * (add / remove / replace). Payload-free — listeners re-fetch via
   * {@link list} to see the new state.
   *
   * Returns an unsubscribe. Listener errors do NOT affect siblings.
   */
  subscribeAll(listener: () => void): Unsubscribe;
}

/**
 * Mutation surface for the reference in-memory implementation. Kept
 * separate from {@link ToolCatalog} so consumers (like the MCP
 * server projection) can't accidentally mutate the source they're
 * observing.
 */
export interface MutableToolCatalog extends ToolCatalog {
  /**
   * Add a tool declaration. Throws if a tool with the same name is
   * already registered — replace via {@link replace} instead.
   */
  register(declaration: ToolDeclaration): void;

  /**
   * Remove a tool by name. Silent no-op if the name isn't
   * registered.
   */
  remove(name: string): void;

  /**
   * Atomic add-or-replace. Fires the change notifier once.
   */
  replace(declaration: ToolDeclaration): void;

  /**
   * Replace the entire tool set atomically. Fires the change notifier
   * exactly once regardless of how many entries changed.
   */
  setAll(declarations: readonly ToolDeclaration[]): void;
}

/**
 * Build a mutable in-memory tool catalog. The typical adopter usage:
 *
 * ```ts
 * const tools = createToolCatalog([initialTool1, initialTool2]);
 *
 * mcpServerHarness({ tools }); // projection subscribes internally
 *
 * // Later, on some trigger:
 * tools.register(anotherTool); // MCP clients get notifications/tools/list_changed
 * ```
 */
export function createToolCatalog(initial: readonly ToolDeclaration[] = []): MutableToolCatalog {
  const byName = new Map<string, ToolDeclaration>();
  for (const decl of initial) byName.set(decl.name, decl);
  // Foundational single-channel notifier — snapshot-on-fire +
  // per-listener error isolation, same as every other harness change
  // fan-out (credentials, knobs, prompts, ...). No hand-rolled Set.
  const changes = createNotifier();

  return {
    list(): readonly ToolDeclaration[] {
      return Array.from(byName.values());
    },
    subscribeAll(listener) {
      return changes.subscribe(listener);
    },
    register(declaration) {
      if (byName.has(declaration.name)) {
        throw new Error(
          `ToolCatalog: tool "${declaration.name}" already registered — use replace() to swap.`,
        );
      }
      byName.set(declaration.name, declaration);
      changes.notify();
    },
    remove(name) {
      if (!byName.has(name)) return;
      byName.delete(name);
      changes.notify();
    },
    replace(declaration) {
      byName.set(declaration.name, declaration);
      changes.notify();
    },
    setAll(declarations) {
      byName.clear();
      for (const decl of declarations) byName.set(decl.name, decl);
      changes.notify();
    },
  };
}

/**
 * Wrap a fixed array as a read-only catalog. `subscribeAll` is a
 * no-op — this catalog never changes. Used by the MCP server
 * projection to normalize the "static array" adopter shape onto the
 * `ToolCatalog` interface without special-casing the projection code
 * path.
 */
export function staticToolCatalog(declarations: readonly ToolDeclaration[]): ToolCatalog {
  const snapshot = Array.from(declarations);
  return {
    list: () => snapshot,
    subscribeAll: () => () => {},
  };
}

/**
 * True if `x` walks like a {@link ToolCatalog}. Duck-typed on the two
 * interface methods — allows adopters to bring their own catalog
 * implementation without importing our concrete class.
 */
export function isToolCatalog(x: unknown): x is ToolCatalog {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as { list?: unknown; subscribeAll?: unknown };
  return typeof obj.list === "function" && typeof obj.subscribeAll === "function";
}
