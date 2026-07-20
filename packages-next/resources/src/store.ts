/**
 * Resource store — durable backing for the resources library (data-layer plan
 * §6-C, Phase 5 run #9, the definition-library archetype's **richest instance**).
 *
 * The store holds the **serializable slice** of a resource binding — a
 * {@link ResourceDeclarationRecord} (`uri` / `uriTemplate` / `kind` / `meta`), which is
 * the binding MINUS its non-serializable `resolver` fn. The resolver is NOT a
 * store concern: the {@link import("./harness.js").ResourcesHarness} keeps it in a
 * parallel harness-local sidecar, so it can NEVER reach the store — the record
 * type makes that a compile-time guarantee, exactly as `InMemoryPromptStore`
 * excludes `render`/`template`.
 *
 * **One collection, `kind`-discriminated.** Fixed resources key by `uri`,
 * templates by `uriTemplate`; the record's `kind` discriminates. A single
 * {@link MemoryCollection} (keyed by `resourceDeclarationKey` = `uri ??
 * uriTemplate`) backs both — template keys always contain `{…}` and fixed uris
 * never do, so the key-spaces are disjoint in practice. {@link matchesResourceQuery}
 * enumerates one class (`list({ kind })`) or filters by `uri` substring.
 *
 * @see docs/proposals/v2/data-layer-plan.md §6-C
 */

import type {
  ResourceDeclarationRecord,
  ResourceStore,
  ResourceStoreQuery,
  StoreCtx,
} from "@agentick/spec-next";
import { resourceDeclarationKey } from "@agentick/spec-next";
import { MemoryCollection } from "@agentick/store-next";

/**
 * The store-level filter: an optional `kind` class enumeration AND an optional
 * case-insensitive `uri` substring over the record's key (`uri ?? uriTemplate`).
 * `query === undefined` (or an empty query) matches every declaration. Every
 * provided dimension ANDs together.
 */
export function matchesResourceQuery(
  declaration: ResourceDeclarationRecord,
  query: ResourceStoreQuery | undefined,
): boolean {
  if (query === undefined) return true;
  if (query.kind !== undefined && declaration.kind !== query.kind) return false;
  if (query.uri !== undefined && query.uri !== "") {
    const key = resourceDeclarationKey(declaration);
    if (!key.toLowerCase().includes(query.uri.toLowerCase())) return false;
  }
  return true;
}

/**
 * The bundled, zero-dependency default resource store — the generic
 * {@link MemoryCollection} parameterized for {@link ResourceDeclarationRecord} (keyed by
 * `resourceDeclarationKey`, filtered by {@link matchesResourceQuery}). `:memory:`
 * semantics (lost on process exit); a durable adapter (Postgres, a filesystem
 * source) conforms to the same {@link ResourceStore} port. This is the reference
 * `runResourceStoreConformance` validates every adapter against.
 */
export class InMemoryResourceStore implements ResourceStore {
  readonly backend = "memory";
  private readonly collection = new MemoryCollection<ResourceDeclarationRecord, ResourceStoreQuery>(
    {
      backend: "memory",
      keyOf: resourceDeclarationKey,
      matchQuery: matchesResourceQuery,
    },
  );

  put(declaration: ResourceDeclarationRecord, ctx: StoreCtx): Promise<void> {
    return this.collection.put(declaration, ctx);
  }

  get(key: string, ctx: StoreCtx): Promise<ResourceDeclarationRecord | undefined> {
    return this.collection.get(key, ctx);
  }

  list(
    query: ResourceStoreQuery | undefined,
    ctx: StoreCtx,
  ): Promise<readonly ResourceDeclarationRecord[]> {
    return this.collection.list(query, ctx);
  }

  async delete(key: string, ctx: StoreCtx): Promise<void> {
    await this.collection.delete(key, ctx);
  }
}
