/**
 * `SkillStore` — the durable backing port for the skills library (the
 * **definition-library** archetype, data-layer plan §6-C / §3 disposition).
 *
 * Skills are the archetype's **pure floor**: a serializable, string-keyed
 * {@link Skill} record ({@link SkillStore} = {@link CollectionStore} keyed by
 * `name`), fed by pluggable read-only `Loader` sources, with **no runtime
 * augmentation** (unlike prompts' `render`/`template` fn or resources'
 * `resolver`) — every field of a `Skill` is a string / plain data, so the store
 * round-trips it whole. Prompts and resources extend THIS shape by turning on
 * more axes (augmentation, an eager catalog projection); skills turns on none.
 *
 * Port home is spec-next (§6-D): the cross-package contract — the harness
 * consumes it, adapter packages implement it, only spec-next is a shared dep.
 * The bundled in-memory default ({@link import("@agentick/skills-next").InMemorySkillStore})
 * and the `runSkillStoreConformance` suite live in `@agentick/skills-next`
 * (mirrors `TaskStore` / `TimelineStore`; spec-next stays vitest-free). A durable
 * adapter (`@agentick/skills-store-postgres-next`, a filesystem source) conforms
 * to this SAME port.
 *
 * @see docs/proposals/v2/data-layer-plan.md §6-C
 * @see ./skills-harness.ts
 */

import type { Skill } from "./skills-harness.js";
import type { CollectionStore } from "./store.js";

/**
 * Filter for {@link SkillStore.list} — the store-level twin of the harness's
 * `search()` predicate (mirrors it field for field, minus the read-cap `limit`,
 * which is a result-slice concern applied by the caller, not a match dimension).
 *
 * All dimensions AND together; omitting the query returns every skill.
 */
export interface SkillStoreQuery {
  /**
   * Substring matched against `name` + `description` (case-insensitive).
   * Implementations MAY upgrade to fuzzy / embedding search; the in-memory
   * reference impl is substring-only.
   */
  readonly query?: string;
  /** Match skills carrying at least one of these tags (OR semantics). */
  readonly tagsAny?: readonly string[];
  /** Match skills carrying every one of these tags (AND semantics). */
  readonly tagsAll?: readonly string[];
}

/**
 * Adopter-pluggable durable backing for the skills library — a CRUD port keyed
 * by `Skill.name`, queryable by substring + tags. Upsert-on-register/update;
 * NO `subscribe` (the harness owns its own change fan-out). Swappable +
 * conformance-parameterized (`runSkillStoreConformance(factory)` in
 * `@agentick/skills-next`), exactly like `TaskStore` / the timeline stores.
 *
 * A `CollectionStore<Skill, SkillStoreQuery>` (the collection archetype,
 * data-layer plan §2.1). The method declarations below narrow the archetype's
 * contract to the skill-specific shape (parameter names, `delete` →
 * `Promise<void>`); they MUST stay assignable to {@link CollectionStore} so any
 * generic collection-store tooling accepts a `SkillStore`.
 */
export interface SkillStore extends CollectionStore<Skill, SkillStoreQuery> {
  /** Upsert — a later `put` of the same `name` replaces the record. */
  put(skill: Skill): Promise<void>;
  get(name: string): Promise<Skill | undefined>;
  /** By substring / tags. Omitting the query returns every skill. */
  list(query?: SkillStoreQuery): Promise<readonly Skill[]>;
  delete(name: string): Promise<void>;
  /** Self-identifying backend label for observability (`"memory"`, `"postgres"`, …). */
  readonly backend: string;
}
