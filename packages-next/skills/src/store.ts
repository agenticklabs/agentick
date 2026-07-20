/**
 * Skill store — durable backing for the skills library (data-layer plan §6-C,
 * Phase 5 "the definition-library PURE floor").
 *
 * A `Skill` is entirely serializable (name / description / content are strings,
 * tags a string array, metadata plain data), so — unlike knobs (values only,
 * descriptors tree-derived) — the store holds the **whole** record. There is no
 * runtime augmentation to strip: skills is the archetype floor prompts and
 * resources build on.
 *
 * {@link matchesSkillQuery} is the single search predicate, shared by BOTH the
 * store's `matchQuery` (the async `list(query)` path — hydrate, cross-process
 * adapters) and the harness's synchronous `search()` over its projection cache,
 * so the two can never drift.
 *
 * @see docs/proposals/v2/data-layer-plan.md §6-C
 */

import type {
  CollectionMutation,
  Skill,
  SkillStore,
  SkillStoreQuery,
  StoreCtx,
} from "@agentick/spec-next";
import { MemoryCollection } from "@agentick/store-next";

/**
 * The shared search predicate: substring against `name` + `description`
 * (case-insensitive), `tagsAny` (OR), `tagsAll` (AND) — every provided
 * dimension AND together. `query === undefined` (or an empty query object)
 * matches every skill. Mirrors the `SkillsSearchInput` semantics minus the
 * read-cap `limit`, which the caller applies to the result slice.
 */
export function matchesSkillQuery(skill: Skill, query: SkillStoreQuery | undefined): boolean {
  if (query === undefined) return true;
  if (query.query !== undefined && query.query !== "") {
    const needle = query.query.toLowerCase();
    const hay = `${skill.name.toLowerCase()} ${skill.description.toLowerCase()}`;
    if (!hay.includes(needle)) return false;
  }
  if (query.tagsAny && query.tagsAny.length > 0) {
    const tags = skill.tags ?? [];
    if (!query.tagsAny.some((t) => tags.includes(t))) return false;
  }
  if (query.tagsAll && query.tagsAll.length > 0) {
    const tags = skill.tags ?? [];
    if (!query.tagsAll.every((t) => tags.includes(t))) return false;
  }
  return true;
}

/**
 * The bundled, zero-dependency default skill store — the generic
 * {@link MemoryCollection} parameterized for `Skill` records (keyed by `name`,
 * filtered by {@link matchesSkillQuery}). `:memory:` semantics (lost on process
 * exit); a durable adapter (Postgres, a filesystem source) conforms to the same
 * {@link SkillStore} port. This is the reference `runSkillStoreConformance`
 * validates every adapter against.
 */
export class InMemorySkillStore implements SkillStore {
  readonly backend = "memory";
  private readonly collection = new MemoryCollection<Skill, SkillStoreQuery>({
    backend: "memory",
    keyOf: (skill) => skill.name,
    matchQuery: matchesSkillQuery,
  });

  put(skill: Skill, ctx: StoreCtx): Promise<void> {
    return this.collection.put(skill, ctx);
  }

  get(name: string, ctx: StoreCtx): Promise<Skill | undefined> {
    return this.collection.get(name, ctx);
  }

  list(query: SkillStoreQuery | undefined, ctx: StoreCtx): Promise<readonly Skill[]> {
    return this.collection.list(query, ctx);
  }

  async delete(name: string, ctx: StoreCtx): Promise<void> {
    await this.collection.delete(name, ctx);
  }

  // TODO(store-cut2): drops out once CollectionStore extends Store
  // (Cut 2b) — the composed MemoryCollection already implements the seam, so these
  // two delegates are the whole cost of satisfying `Store` today.
  query(q: SkillStoreQuery | undefined, ctx: StoreCtx): Promise<readonly Skill[]> {
    return this.collection.query(q, ctx);
  }

  mutate(m: CollectionMutation<Skill>, ctx: StoreCtx): Promise<void> {
    return this.collection.mutate(m, ctx);
  }
}
