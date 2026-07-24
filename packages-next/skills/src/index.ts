/**
 * @agentick/skills-next — SkillsHarness for durable, searchable agent
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
export { runSkillsHarnessConformance } from "./conformance.js";
// ADR 68-style store archetype (data-layer plan §6-C — the definition-library
// PURE floor). The bundled in-memory default + its search predicate; the
// `SkillStore` / `SkillStoreQuery` ports live in `@agentick/spec-next`. A
// durable adapter conforms to the SAME port later.
export { InMemorySkillStore, matchesSkillQuery } from "./store.js";
export {
  runSkillStoreConformance,
  type SkillStoreConformanceOptions,
} from "./store-conformance.js";
