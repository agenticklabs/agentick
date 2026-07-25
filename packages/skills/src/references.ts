/**
 * Skill reference wiring — the UNIVERSAL seam between the Node loader
 * (`agentSkillsDirectory`, which discovers `<skill>/references/*` files) and
 * the resources harness (which serves them to the model via `resource_read`).
 *
 * This module is **universal** (no `node:*` imports) so `extension.ts` — the
 * package's main-entrypoint install path, which must stay browser-safe — can
 * read the wiring off a loaded record and register it into
 * `installer.resources` WITHOUT pulling `node:fs` into the universal bundle.
 * The resolver CLOSURES themselves are built on the Node side
 * (`loaders-node.ts`, where `node:fs/promises` lives); this file only carries +
 * reads them.
 *
 * ## The two representations
 *
 *  - `metadata.references: readonly SkillReference[]` — PURE DATA
 *    (`{ uri, path }`). Serializable; survives the durable store and snapshot /
 *    restore. This is what an adopter inspecting `skill.metadata` sees.
 *  - `metadata[SKILL_REFERENCE_WIRING]: readonly SkillReferenceWiring[]` —
 *    TRANSIENT (`{ uri, resolver, meta }`). Carries the lazy `node:fs`-backed
 *    resolver closure. Functions do NOT survive JSON serialization, so this key
 *    never reaches the durable store — it exists only on the in-memory record
 *    returned by `loader.load()`, consumed once at install by `extension.ts`.
 *    (Restore drift: see the `TODO(E2-reload)` in `extension.ts`.)
 *
 * @see docs/proposals/v2/three-audiences-plan.md §E2
 */

import type { ResourceMeta, ResourceResolver, Skill, SkillsRegisterInput } from "@agentick/spec";

/**
 * Metadata key under which the Node loader stashes transient reference-resource
 * wiring. Namespaced to avoid collision with adopter-defined metadata; obvious
 * on inspection that it is framework-internal.
 */
export const SKILL_REFERENCE_WIRING = "@agentick/skills/reference-wiring";

/** Pure-data reference descriptor persisted on `Skill.metadata.references`. */
export interface SkillReference {
  /** `skill://<name>/references/<relpath>` — the resource uri the model reads. */
  readonly uri: string;
  /** Absolute path on disk the resolver reads from. */
  readonly path: string;
}

/**
 * Transient wiring for one reference file — the uri, a lazy resolver (built on
 * the Node side, closes over `node:fs`), and the resource descriptor meta.
 */
export interface SkillReferenceWiring {
  readonly uri: string;
  readonly resolver: ResourceResolver;
  readonly meta: ResourceMeta;
}

/**
 * Read the transient reference wiring off a loaded skill record. Returns `[]`
 * when the record carries none (every non-`agentSkillsDirectory` source, and
 * `agentSkillsDirectory` skills that have no `references/` directory).
 * Universal — no `node:*` dependency.
 */
export function readSkillReferenceWiring(
  skill: Skill | SkillsRegisterInput,
): readonly SkillReferenceWiring[] {
  const raw = skill.metadata?.[SKILL_REFERENCE_WIRING];
  return Array.isArray(raw) ? (raw as readonly SkillReferenceWiring[]) : [];
}
