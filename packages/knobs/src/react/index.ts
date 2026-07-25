/**
 * `@agentick/knobs/react` — React bindings for KnobsHarness.
 *
 * Per ADR 27, the React surface for a harness lives in its own /react
 * subpath. Adopters using `@agentick/compiler-react` import the
 * hooks and components from here.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Side-effect import — registers the HookBridges.knobs slot.
import "../augment.js";

export { useKnob, type UseKnobOptions } from "./use-knob.js";
export {
  Knobs,
  useKnobsContext,
  useKnobsContextOptional,
  type KnobsProps,
  type KnobsRenderFn,
  type KnobsContextValue,
  type KnobInfo,
  type KnobGroup,
} from "./knobs.js";
