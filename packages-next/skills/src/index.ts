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

export { SkillsHarness } from "./harness.js";
export type { SkillsHandle } from "./handle.js";
export { withSkills, type WithSkillsOptions } from "./extension.js";
export { runSkillsHarnessConformance } from "./conformance.js";
