/**
 * @agentick/state — StateHarness extraction (ADR 26 Step 3a).
 *
 * Private workspace package. Bundled into the `agentick` metapackage;
 * not published independently. Adopters consume `withState()` +
 * `StateHarness` via the metapackage.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Side-effect import — registers the `bridges.state` slot on
// `HookBridges` via TypeScript module augmentation. Per ADR 27, every
// harness package owns its own slot declaration.
import "./augment.js";

export { StateHarness } from "./harness.js";
export type { StateHandle } from "./handle.js";
export { withState, type WithStateOptions } from "./extension.js";
export { runStateHarnessConformance } from "./conformance.js";
