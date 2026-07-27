/**
 * @agentick/skills — SkillsHarness for durable, searchable agent
 * skill libraries (OpenClaw / Hermes style).
 *
 * Shape 1 harness per ADR 32 — substrate participation, audit
 * envelopes, swappable backend, snapshot/restore.
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 */

// Side-effect import — registers the `bridges.skills` slot on
// `HookBridges` via TypeScript module augmentation.
import "./augment.js";

export { SkillsHarness, type SkillsHarnessOptions } from "./harness.js";
export type { SkillsHandle, SkillRunCompose, SkillRunOptions } from "./handle.js";
export { defaultComposeRun } from "./compose-run.js";
export { withSkills, type WithSkillsOptions } from "./extension.js";
// ADR 93 — the namespace definition: the store, the genesis seam, this
// namespace's shaping seams, and the `hooks:` / `guards:` bags. One object for
// both `createApp({ skills })` and `withSkills(...)`.
export {
  defineSkills,
  isSkillsDefinition,
  type BrandedSkillsDefinition,
  type SkillSeed,
  type SkillsConfig,
  type SkillsDefinition,
  type SkillsHydrateCtx,
  type SkillsHydrator,
  type SkillsStore,
} from "./definition.js";
// The named hydrators — the genesis-seam library, and the ONE source vocabulary
// (a literal array, a manifest, the durable store, or several composed). The
// filesystem sources need `node:fs` and ship from `@agentick/skills/hydrators/node`.
export {
  composeHydrators,
  hydrateFrom,
  hydrateFromManifest,
  hydrateFromStore,
  hydrateFromUrl,
  type HydrateFromUrlOptions,
} from "./hydrators.js";
// E2 — reference-file wiring. `SkillReference` (`{ uri, path }`) is the
// pure-data descriptor persisted on `skill.metadata.references`; the transient
// resolver wiring + reader stay internal to the install path.
export {
  readSkillReferenceWiring,
  SKILL_REFERENCE_WIRING,
  type SkillReference,
  type SkillReferenceWiring,
} from "./references.js";
// `skill://<name>` body projection (three-audiences-plan §0/§E2) — the
// uniform-addressing door; the reference FILES already ride `skill://<name>/
// references/*`, this makes the body itself addressable. Wired by `withSkills`.
export { skillBodyUri, wireSkillProjection } from "./projection.js";
export { buildSkillsTools, SKILL_LIST, SKILL_READ, type SkillsToolsBundle } from "./tools.js";
// ADR 68-style store archetype (data-layer plan §6-C — the definition-library
// PURE floor). The bundled in-memory default + its search predicate; the
// `SkillStore` / `SkillStoreQuery` ports live in `@agentick/spec`. A
// durable adapter conforms to the SAME port later.
export { InMemorySkillStore, matchesSkillQuery } from "./store.js";
