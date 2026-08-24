/**
 * `@agentick/gates` — knob-backed continuation conditions.
 *
 * A gate is a rule about loop continuation. Three species:
 *
 *   - **Latch gates** (`activateWhen`) — edge-triggered; the model
 *     clears via `knob_set` (three states: `inactive`/`active`/`deferred`).
 *   - **Verified gates** (`satisfied`) — level-triggered; a code
 *     predicate evaluated every tick auto-clears on pass and re-engages
 *     on regression. Backing knob is read-only to the model.
 *   - **Stop gates** (`stopWhen`) — the inverse: they end a turn that
 *     would continue. No knob, no value, invisible to the model.
 *     `stopOnTools("done")` is the shipped factory.
 *
 * A value gate's cell lives in the session's KnobsHarness — gates have no
 * independent state, no separate harness, no inbox address.
 *
 * This root is compiler-agnostic — the pure descriptor types +
 * `gate()` factory, plus the {@link GatesController} wiring core that
 * both front-ends converge on. The React hook lives in the `/react`
 * subpath:
 * ```ts
 * import { useGate } from "@agentick/gates/react";
 * ```
 * Non-React compilers implement their own gate hook against the same
 * descriptor shapes + the same controller.
 *
 * `session.gates` / `session.gate(name)` are declared here via module
 * augmentation of `SessionHarnessProtocol` (see `./augment.ts`).
 */

export {
  gate,
  gateSpecies,
  isStopGate,
  isVerifiedGate,
  stopOnTools,
  GATE_OPTIONS,
  VERIFIED_GATE_OPTIONS,
} from "./descriptor.js";
export type {
  GateDescriptor,
  GateSpecies,
  LatchGateDescriptor,
  StopGateDescriptor,
  ValueGateDescriptor,
  VerifiedGateDescriptor,
  GateValue,
} from "./descriptor.js";

export { GatesController } from "./controller.js";
export type {
  GatesControllerDeps,
  GatesParentLayer,
  GateKnobs,
  LoopControlSeam,
  GateOverrideAudit,
  GateOverrideOrigin,
  GateInfo,
  GateHandle,
  GatesHandle,
} from "./controller.js";

export { GatesHarness } from "./harness.js";
export type {
  GatesHarnessDeps,
  GatesClearInput,
  GatesDeferInput,
  GatesOverrideInput,
} from "./harness.js";

// Side-effect: augment `SessionHarnessProtocol` with `gates` + `gate()`.
import "./augment.js";
