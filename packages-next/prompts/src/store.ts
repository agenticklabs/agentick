/**
 * Prompt store — durable backing for the prompts library (data-layer plan §6-C,
 * Phase 5 "the definition-library archetype", first **augmented instance**).
 *
 * The store holds the **serializable slice** of a prompt — a
 * {@link PromptDeclarationRecord} (`name` / `description` / `arguments` /
 * `metadata`), which is exactly `PromptDeclaration` MINUS its two
 * non-serializable runtime-augmentation fields (`template`, `render`). Those fns
 * are NOT a store concern: the {@link import("./harness.js").PromptsHarness}
 * keeps them in a parallel sidecar map, so `template`/`render` can NEVER reach
 * the store — the record type makes that a compile-time guarantee, not a
 * discipline. This is the ONE difference from `InMemorySkillStore` (which holds
 * the whole record because a `Skill` is fully serializable).
 *
 * {@link matchesPromptQuery} is the single search predicate the store's
 * `matchQuery` uses. Unlike skills, the prompts harness has no `search()` — its
 * `list()` enumerates everything — so this predicate is store-side only (async
 * `list(query)`: durable adapters, cross-process reads).
 *
 * @see docs/proposals/v2/data-layer-plan.md §6-C
 */

import type {
  CollectionMutation,
  PromptDeclarationRecord,
  PromptStore,
  PromptStoreQuery,
  StoreCtx,
} from "@agentick/spec-next";
import { MemoryCollection } from "@agentick/store-next";

/**
 * The store-level filter: optional case-insensitive `name` substring.
 * `query === undefined` (or an empty query) matches every record. Prompts has no
 * richer search surface (see the file doc), so `name` is the single dimension.
 */
export function matchesPromptQuery(
  record: PromptDeclarationRecord,
  query: PromptStoreQuery | undefined,
): boolean {
  if (query === undefined) return true;
  if (query.name !== undefined && query.name !== "") {
    if (!record.name.toLowerCase().includes(query.name.toLowerCase())) return false;
  }
  return true;
}

/**
 * The bundled, zero-dependency default prompt store — the generic
 * {@link MemoryCollection} parameterized for {@link PromptDeclarationRecord}
 * (keyed by `name`, filtered by {@link matchesPromptQuery}). `:memory:` semantics
 * (lost on process exit); a durable adapter (Postgres, a filesystem source)
 * conforms to the same {@link PromptStore} port. This is the reference
 * `runPromptStoreConformance` validates every adapter against.
 */
export class InMemoryPromptStore implements PromptStore {
  readonly backend = "memory";
  private readonly collection = new MemoryCollection<PromptDeclarationRecord, PromptStoreQuery>({
    backend: "memory",
    keyOf: (record) => record.name,
    matchQuery: matchesPromptQuery,
  });

  put(record: PromptDeclarationRecord, ctx: StoreCtx): Promise<void> {
    return this.collection.put(record, ctx);
  }

  get(name: string, ctx: StoreCtx): Promise<PromptDeclarationRecord | undefined> {
    return this.collection.get(name, ctx);
  }

  list(
    query: PromptStoreQuery | undefined,
    ctx: StoreCtx,
  ): Promise<readonly PromptDeclarationRecord[]> {
    return this.collection.list(query, ctx);
  }

  async delete(name: string, ctx: StoreCtx): Promise<void> {
    await this.collection.delete(name, ctx);
  }

  // TODO(reactive-store-cut2): drops out once CollectionStore extends ReactiveStore
  // (Cut 2b) — the composed MemoryCollection already implements the seam, so these
  // two delegates are the whole cost of satisfying `ReactiveStore` today.
  query(
    q: PromptStoreQuery | undefined,
    ctx: StoreCtx,
  ): Promise<readonly PromptDeclarationRecord[]> {
    return this.collection.query(q, ctx);
  }

  mutate(m: CollectionMutation<PromptDeclarationRecord>, ctx: StoreCtx): Promise<void> {
    return this.collection.mutate(m, ctx);
  }
}
