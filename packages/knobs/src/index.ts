/**
 * @agentick/knobs — KnobsHarness extraction (ADR 26 Step 2).
 *
 * Private workspace package. Bundled into the `agentick` metapackage;
 * not published independently. Adopters consume `withKnobs()` +
 * `KnobsHarness` types via the metapackage.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

export { KnobsHarness } from "./harness.js";
export { withKnobs, type WithKnobsOptions } from "./extension.js";
export { runKnobsHarnessConformance } from "./conformance.js";
