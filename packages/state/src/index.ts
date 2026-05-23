/**
 * @agentick/state — StateHarness extraction (ADR 26 Step 3a).
 *
 * Private workspace package. Bundled into the `agentick` metapackage;
 * not published independently. Adopters consume `withState()` +
 * `StateHarness` via the metapackage.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

export { StateHarness } from "./harness.js";
export { withState, type WithStateOptions } from "./extension.js";
export { runStateHarnessConformance } from "./conformance.js";
