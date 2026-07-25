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
export type { KnobsHandle } from "./handle.js";
export {
  KNOBS_STATE_CHANNEL,
  KNOBS_STATE_CHANNEL_FQN,
  knobPointer,
  toWireDescriptor,
  type KnobsStateChannelName,
  type KnobsStateFrame,
  type KnobsStateSnapshotFrame,
  type KnobsStateDeltaFrame,
  type WireKnobDescriptor,
} from "./channel.js";
export { createKnobStore, type KnobEntry, type KnobStoreQuery } from "./store.js";
export { withKnobs, type WithKnobsOptions } from "./extension.js";
export { knobsWireExtension } from "./wire.js";
