/**
 * `ResourceStore` — the durable backing port for the resources library (the
 * **definition-library** archetype's **richest instance**, data-layer plan §6-C /
 * §3 disposition, Phase 5 run #9).
 *
 * Resources is the archetype with the most axes turned on. Like prompts it splits
 * a serializable **declaration** from a non-serializable runtime augmentation —
 * but where prompts' augmentation is `render`/`template`, resources' is the
 * `resolver` fn. The store holds ONLY the {@link ResourceDeclarationRecord} (`uri` /
 * `uriTemplate` / `kind` / `meta`); the resolver lives in a harness-local sidecar
 * and NEVER reaches the store — the record type makes that a compile-time
 * guarantee, exactly as `PromptDeclarationRecord` excludes `render`/`template`.
 *
 * Two source classes coexist (the resources-specific twist, data-layer plan
 * Phase 5): **durable** declarations from a {@link ResourceLoader} (DB/fs — the
 * source resources lacks today) land in this store; **transient** declarations
 * from `register`/`registerTemplate`/`<Resource>` tree-mounts are registry-only
 * and re-mount on restart. So — unlike prompts — NOT every declaration is stored.
 * This store is therefore the durable-source backing, NOT a snapshot: the
 * resources harness stays deliberately NOT `SnapshotCapable`. Durability = the
 * store reloads declarations from its `ResourceLoader` source on restart; the
 * transient bindings re-mount from the tree.
 *
 * **Dual-key model — one collection, `kind`-discriminated.** Fixed resources are
 * keyed by `uri`, templates by `uriTemplate`; the record's `kind` discriminates.
 * A single {@link CollectionStore} (keyed by `uri ?? uriTemplate`) backs both —
 * template keys always contain `{…}` expressions and fixed uris never do, so the
 * two key-spaces are disjoint in practice. The `kind`-aware {@link
 * ResourceStoreQuery} enumerates one class (`list({ kind: "template" })`); exact
 * lookup is `get(uri)`.
 *
 * Port home is @agentick/spec (§6-D): the cross-package contract — the harness consumes
 * it, adapter packages implement it, only @agentick/spec is a shared dep. The bundled
 * in-memory default ({@link import("@agentick/resources").InMemoryResourceStore})
 * and the `runResourceStoreConformance` suite live in `@agentick/resources`
 * (mirrors `PromptStore` / `SkillStore`; @agentick/spec stays vitest-free).
 *
 * @see docs/proposals/v2/data-layer-plan.md §6-C
 * @see ./prompts-store.ts
 * @see ./resources-harness.ts
 */

import type { ResourceMeta } from "./resources-harness.js";
import type { CollectionStore } from "./store.js";
import type { StoreCtx } from "./store-ctx.js";

/**
 * The **serializable slice** of a resource binding — the persisted record the
 * {@link ResourceStore} holds. It is the declaration MINUS the non-serializable
 * `resolver` fn (the resources augmentation), which lives in the harness's
 * sidecar. `kind` discriminates the two shapes:
 *   - `kind: "fixed"`    → `uri` is set (`uriTemplate` absent).
 *   - `kind: "template"` → `uriTemplate` is set (`uri` absent).
 *
 * `meta` is typed as {@link ResourceMeta} for both classes: a template's
 * `ResourceTemplateMeta` is structurally `ResourceMeta` minus `size`, so the
 * wider type accommodates both without a union (a template simply carries no
 * `size`).
 */
export interface ResourceDeclarationRecord {
  /** Set when `kind: "fixed"`. The exact uri the binding resolves. */
  readonly uri?: string;
  /** Set when `kind: "template"`. The RFC 6570-lite pattern the binding matches. */
  readonly uriTemplate?: string;
  /** Discriminator — `"fixed"` (exact `uri`) or `"template"` (`uriTemplate` pattern). */
  readonly kind: "fixed" | "template";
  /** Descriptor metadata (name / description / mimeType / …). Never the resolver. */
  readonly meta?: ResourceMeta;
}

/**
 * Filter for {@link ResourceStore.list}. Covers the two enumerations the harness
 * needs beyond exact-key `get`: **class enumeration** (`kind` — list every fixed
 * OR every template) and an optional `uri` substring over the record's key
 * (`uri ?? uriTemplate`). Every provided dimension ANDs together; `undefined` (or
 * an empty query) returns every declaration.
 */
export interface ResourceStoreQuery {
  /** Enumerate one class only — `"fixed"` or `"template"`. Omit → both. */
  readonly kind?: "fixed" | "template";
  /** Substring matched (case-insensitive) against `uri ?? uriTemplate`. Omit → all. */
  readonly uri?: string;
}

/**
 * Adopter-pluggable durable backing for the resources library — a CRUD port keyed
 * by `uri ?? uriTemplate`. Upsert-on-load; NO `subscribe` (the harness owns its
 * own `list_changed` / `updated` fan-out). Swappable +
 * conformance-parameterized (`runResourceStoreConformance(factory)` in
 * `@agentick/resources`), exactly like `PromptStore` / `SkillStore`.
 *
 * A `CollectionStore<ResourceDeclarationRecord, ResourceStoreQuery>` (the collection
 * archetype, data-layer plan §2.1). The method declarations below narrow the
 * archetype's contract to the resource-declaration shape; they MUST stay
 * assignable to {@link CollectionStore} so any generic collection-store tooling
 * accepts a `ResourceStore`. The record is the SERIALIZABLE slice only — the
 * `resolver` fn never reaches here.
 */
export interface ResourceStore extends CollectionStore<
  ResourceDeclarationRecord,
  ResourceStoreQuery
> {
  /** Upsert — a later `put` of the same key (`uri`/`uriTemplate`) replaces the record. */
  put(declaration: ResourceDeclarationRecord, ctx: StoreCtx): Promise<void>;
  /** By exact key (`uri` for fixed, `uriTemplate` for template). `undefined` when absent. */
  get(key: string, ctx: StoreCtx): Promise<ResourceDeclarationRecord | undefined>;
  /** By `kind` / `uri` substring. Omitting the query returns every declaration. */
  list(
    query: ResourceStoreQuery | undefined,
    ctx: StoreCtx,
  ): Promise<readonly ResourceDeclarationRecord[]>;
  /** Idempotent — deleting an absent key never throws. */
  delete(key: string, ctx: StoreCtx): Promise<void>;
  /** Self-identifying backend label for observability (`"memory"`, `"postgres"`, …). */
  readonly backend: string;
}

/**
 * The stable `Map` key for a declaration: `uri` for a fixed resource,
 * `uriTemplate` for a template. Exported so the harness's projection and the
 * store share ONE keying rule (drift would desync the catalog from the store).
 */
export function resourceDeclarationKey(declaration: ResourceDeclarationRecord): string {
  return declaration.uri ?? declaration.uriTemplate ?? "";
}
