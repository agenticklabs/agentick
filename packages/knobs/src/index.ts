/**
 * @agentick/knobs — KnobsHarness extraction (ADR 26 Step 2).
 *
 * Private workspace package. Bundled into the `agentick` metapackage;
 * not published independently. Adopters consume `withKnobs()` +
 * `KnobsHarness` types via the metapackage.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Side-effect import — registers the `bridges.knobs` slot on
// `HookBridges` via TypeScript module augmentation. Per ADR 27, every
// harness package owns its own slot declaration.
import "./augment.js";

export { KnobsHarness } from "./harness.js";
export { withKnobs, type WithKnobsOptions } from "./extension.js";
export { runKnobsHarnessConformance } from "./conformance.js";
