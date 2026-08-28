/**
 * `createToolsHandle` — the server-side `session.tools` projection
 * (three-audiences-plan §F).
 *
 * Tools were the one session collection WITHOUT a curated handle: the raw
 * `session.toolExecutor` (full `ToolExecutorProtocol`) plus the removed
 * `session.dispatch` sugar. This factory builds the {@link ToolsHandle} that
 * reads exactly like the sibling handles (`session.knobs` / `session.state`):
 *
 *   - SYNC View reads — `list`/`get`/`has`. An in-memory registry with a sync
 *     read surface holds a View (the data-layer rule), so these never return a
 *     Promise. `list` rides `compileForTick` (precedence-resolved, ONE
 *     {@link ToolInfo} per name); `get`/`has` ride the registry's name-then-alias
 *     resolution.
 *   - ASYNC `dispatch` — the host door (`via: "dispatch"`), carrying the same
 *     journaling/provenance the removed `session.dispatch` had.
 *   - The family topology-subscription pair — `subscribe(name, fn)` fires when
 *     the named tool's registrations change; `subscribeAll(fn)` fires on any
 *     add/remove. Both ride the registry's change-notification (fired only from
 *     the registration-mutation paths, never the hot dispatch path).
 *
 * The concrete {@link ToolExecutorHarness} builds ONE of these over its own
 * registry + host-door dispatch and exposes it as `toolExecutor.tools`; the
 * session getter (`session.tools`) forwards it.
 *
 * @verifiedBy packages/tool-executor/src/__tests__/tools-handle.spec.ts
 */

import type {
  ToolBinding,
  ContentBlock,
  DispatchOptions,
  DispatchResult,
  ToolDeclaration,
  ToolHandle,
  ToolInfo,
  ToolListFilter,
  ToolRegistration,
  ToolsHandle,
} from "@agentick/spec";

/** The sync-read + dispatch + subscribe primitives the handle folds over. */
export interface ToolsHandleDeps {
  /**
   * Precedence-resolved, deduped registry read (one declaration per name),
   * optionally filtered — i.e. `registry.compileForTick`. The handle's `list`
   * projects each result to a {@link ToolInfo}.
   */
  compileSync(filter?: ToolListFilter): readonly ToolDeclaration[];
  /** Highest-precedence registration for a name (name-then-alias) — `registry.get`. */
  getSync(name: string): ToolRegistration | undefined;
  /**
   * Host-door dispatch (`via: "dispatch"`), returning the tool's content blocks
   * — or the full {@link DispatchResult} under `{ envelope: true }`. Supplied by
   * the harness (it owns the provenance-stamping DispatchInput).
   */
  dispatch(
    name: string,
    input: unknown,
    opts?: DispatchOptions,
  ): Promise<readonly ContentBlock[] | DispatchResult>;
  /** Registry change subscription: `listener(name)`, or `listener(undefined)` for bulk. */
  subscribe(listener: (name: string | undefined) => void): () => void;
}

/** Project a live {@link ToolDeclaration} (+ its binding, when known) to its wire-safe {@link ToolInfo}. */
export function toToolInfo(decl: ToolDeclaration, binding?: ToolBinding): ToolInfo {
  return {
    ...(binding !== undefined ? { binding } : {}),
    name: decl.name,
    description: decl.description,
    ...(decl.summary !== undefined ? { summary: decl.summary } : {}),
    ...(decl.group !== undefined ? { group: decl.group } : {}),
    exposure: decl.exposure,
    ...(decl.aliases !== undefined ? { aliases: decl.aliases } : {}),
    ...(decl.annotations !== undefined ? { annotations: decl.annotations } : {}),
    // The schema itself never crosses — only its presence.
    hasInputSchema: decl.inputSchema !== undefined,
  };
}

export function createToolsHandle(deps: ToolsHandleDeps): ToolsHandle {
  return {
    list: (query) => {
      const filter: ToolListFilter | undefined =
        query?.exposure !== undefined ? { exposure: query.exposure } : undefined;
      return deps
        .compileSync(filter)
        .map((decl) => toToolInfo(decl, deps.getSync(decl.name)?.binding));
    },
    get: (name): ToolHandle | undefined => {
      const reg = deps.getSync(name);
      if (reg === undefined) return undefined;
      // Bind dispatch to the CANONICAL name (an alias lookup resolves to it),
      // so the per-tool handle dispatches the same tool `get` found.
      const canonical = reg.declaration.name;
      return {
        name: canonical,
        info: toToolInfo(reg.declaration, reg.binding),
        dispatch: ((input, opts) =>
          deps.dispatch(canonical, input, opts)) as ToolHandle["dispatch"],
      };
    },
    // Alias-aware existence — `getSync` resolves name-then-alias (registry.has
    // is exact-name only), so `has(alias)` agrees with `get`/`dispatch`.
    has: (name) => deps.getSync(name) !== undefined,
    dispatch: ((name, input, opts) => deps.dispatch(name, input, opts)) as ToolsHandle["dispatch"],
    subscribe: (name, listener) =>
      deps.subscribe((changed) => {
        // A single-name change hits only that name; a bulk change (undefined)
        // may have touched it, so it fires too.
        if (changed === undefined || changed === name) listener();
      }),
    subscribeAll: (listener) => deps.subscribe(() => listener()),
  };
}
