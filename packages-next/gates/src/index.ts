/**
 * `@agentick/gates-next` — knob-backed continuation conditions.
 *
 * A gate blocks loop completion until cleared. Two species:
 *
 *   - **Latch gates** (`activateWhen`) — edge-triggered; the model
 *     clears via `set_knob` (three states: `inactive`/`active`/`deferred`).
 *   - **Verified gates** (`satisfied`) — level-triggered; a code
 *     predicate evaluated every tick auto-clears on pass and re-engages
 *     on regression. Backing knob is read-only to the model.
 *
 * The gate's value lives in the session's KnobsHarness — gates have no
 * independent state, no separate harness, no inbox address.
 *
 * This root is compiler-agnostic — the pure descriptor types +
 * `gate()` factory, plus the {@link GatesController} wiring core that
 * both front-ends converge on. The React hook lives in the `/react`
 * subpath:
 * ```ts
 * import { useGate } from "@agentick/gates-next/react";
 * ```
 * Non-React compilers implement their own gate hook against the same
 * descriptor shapes + the same controller.
 *
 * `session.gates` / `session.gate(name)` are declared here via module
 * augmentation of `SessionHarnessProtocol` (see `./augment.ts`).
 */

export { gate, isVerifiedGate, GATE_OPTIONS, VERIFIED_GATE_OPTIONS } from "./descriptor.js";
export type {
  GateDescriptor,
  LatchGateDescriptor,
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
