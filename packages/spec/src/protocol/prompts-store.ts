/**
 * `PromptStore` — the durable backing port for the prompts library (the
 * **definition-library** archetype's first **augmented instance**, data-layer
 * plan §6-C / §3 disposition).
 *
 * Prompts is skills PLUS a runtime augmentation. The store holds only the
 * **serializable slice** — a {@link PromptDeclarationRecord} ({@link PromptStore}
 * = {@link CollectionStore} keyed by `name`), which is exactly `PromptDeclaration`
 * minus its two non-serializable fields (`template`, `render`). Those fns are NOT
 * a store concern: they live in a parallel harness-local sidecar map, never touch
 * the store, and are re-registered on restore. This is the split that lets the
 * archetype turn on the **augmentation** axis skills leaves off (resources turns
 * on that same axis with its `resolver`, plus an eager catalog projection and a
 * dual-key uri/uriTemplate query — those are resources-specific extensions of
 * THIS shape).
 *
 * Port home is @agentick/spec (§6-D): the cross-package contract — the harness
 * consumes it, adapter packages implement it, only @agentick/spec is a shared dep.
 * The bundled in-memory default ({@link import("@agentick/prompts").InMemoryPromptStore})
 * and the `runPromptStoreConformance` suite live in `@agentick/prompts`
 * (mirrors `SkillStore`; @agentick/spec stays vitest-free). A durable adapter conforms
 * to this SAME port.
 *
 * @see docs/proposals/v2/data-layer-plan.md §6-C
 * @see ./prompts-harness.ts
 * @see ./skills-store.ts
 */

import type { PromptDeclarationRecord } from "./prompts-harness.js";
import type { CollectionStore } from "./store.js";
import type { StoreCtx } from "./store-ctx.js";

/**
 * Filter for {@link PromptStore.list}. Prompts has NO rich search surface (the
 * harness's `list()` enumerates every declaration, sorted by name) — this query
 * is the store-level minimum: an optional case-insensitive `name` substring, the
 * one dimension a durable adapter can meaningfully index. `undefined` (or an
 * empty query) returns every record.
 */
export interface PromptStoreQuery {
  /** Substring matched against `name` (case-insensitive). Omit → match all. */
  readonly name?: string;
}

/**
 * Adopter-pluggable durable backing for the prompts library — a CRUD port keyed
 * by `PromptDeclarationRecord.name`. Upsert-on-register/update; NO `subscribe`
 * (the harness owns its own change fan-out). Swappable +
 * conformance-parameterized (`runPromptStoreConformance(factory)` in
 * `@agentick/prompts`), exactly like `SkillStore` / the timeline stores.
 *
 * A `CollectionStore<PromptDeclarationRecord, PromptStoreQuery>` (the collection
 * archetype, data-layer plan §2.1). The method declarations below narrow the
 * archetype's contract to the prompt-record shape; they MUST stay assignable to
 * {@link CollectionStore} so any generic collection-store tooling accepts a
 * `PromptStore`. The record is the SERIALIZABLE slice only — `template`/`render`
 * never reach here.
 */
export interface PromptStore extends CollectionStore<PromptDeclarationRecord, PromptStoreQuery> {
  /** Upsert — a later `put` of the same `name` replaces the record. */
  put(record: PromptDeclarationRecord, ctx: StoreCtx): Promise<void>;
  get(name: string, ctx: StoreCtx): Promise<PromptDeclarationRecord | undefined>;
  /** By `name` substring. Omitting the query returns every record. */
  list(
    query: PromptStoreQuery | undefined,
    ctx: StoreCtx,
  ): Promise<readonly PromptDeclarationRecord[]>;
  delete(name: string, ctx: StoreCtx): Promise<void>;
  /** Self-identifying backend label for observability (`"memory"`, `"postgres"`, …). */
  readonly backend: string;
}
