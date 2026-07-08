/**
 * Module augmentation — adds the gates surface to `SessionHarnessProtocol`.
 *
 * Gates is NOT a harness: it owns no independent state (a gate's value
 * IS a knob value), so — unlike knobs/state/timeline — it does NOT
 * augment `HookBridges` with a `gates` slot and is NOT snapshot-capable.
 * The controller travels to the reconciler tree inside the existing
 * `BridgeContext` (a runtime, non-typed transport property on the
 * session's bridge bundle), never as a typed `HookBridges` harness slot.
 *
 * What IS declared here: the user-facing session surface, mirroring
 * `session.knobs` / `session.knob(name)`:
 *
 *   - `session.gates`       → curated {@link GatesHandle}
 *                             (`register`/`get`/`list`/`clear`).
 *   - `session.gate(name)`  → per-gate {@link GateHandle}.
 *
 * Loaded as a side effect when anything imports `@agentick/gates-next`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { GateHandle, GatesHandle } from "./controller.js";

declare module "@agentick/spec-next" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's gates — register/get/list/clear over the unified
     * gate registry (tree-declared via `useGate` AND programmatically
     * registered land in the SAME registry). Curated subset of the
     * `GatesController`.
     *
     * For per-gate handles, use `session.gate(name)`.
     */
    readonly gates: GatesHandle;

    /**
     * Per-gate handle by name — value/engaged reads, `clear()`/`defer()`,
     * and the trusted-host `override()` escape for verified gates.
     * Undefined when no gate by that name is registered.
     */
    gate(name: string): GateHandle | undefined;
  }
}
