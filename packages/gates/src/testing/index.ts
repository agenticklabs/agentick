/**
 * `@agentick/gates/testing` — test doubles for the gate wiring.
 *
 * The controller exposes {@link GatesController.handleTickEnd} publicly,
 * so a test can drive the shared wiring directly without a live mount —
 * exactly what the "assert via loop-control seam" programmatic tests
 * want. These helpers assemble a working controller over a real
 * `stubKnobsHarness`, a spy loop-control seam that records
 * continue/stop calls, and an audit sink that records overrides.
 *
 * Doubles follow Meszaros: `fakeGatesController` is a working impl;
 * `spyLoopControl` is a call recorder. Typed against the controller's
 * spec seams so contract drift breaks these at compile time.
 */

import type { KnobsHarnessProtocol, TickResult } from "@agentick/spec";
import { stubKnobsHarness } from "@agentick/knobs/testing";

import { GatesController, type GateOverrideAudit, type LoopControlSeam } from "../controller.js";

/** A {@link LoopControlSeam} that records the reasons it was driven with. */
export interface SpyLoopControl extends LoopControlSeam {
  readonly continueCalls: string[];
  readonly stopCalls: string[];
}

export function spyLoopControl(): SpyLoopControl {
  const continueCalls: string[] = [];
  const stopCalls: string[] = [];
  return {
    continueCalls,
    stopCalls,
    continueAfterTick: (reason: string) => {
      continueCalls.push(reason);
    },
    stopAfterTick: (reason: string) => {
      stopCalls.push(reason);
    },
  };
}

export interface FakeGatesController {
  readonly controller: GatesController;
  /** The real stub knobs harness backing the gate values. */
  readonly knobs: KnobsHarnessProtocol;
  /** Spy loop-control seam — inspect `continueCalls` / `stopCalls`. */
  readonly loop: SpyLoopControl;
  /** Recorded host `.override()` audit envelopes. */
  readonly audits: GateOverrideAudit[];
  /** Drive one tick-end through the shared wiring (no live mount needed). */
  tick(result: TickResult): Promise<void>;
}

/**
 * Build a working {@link GatesController} over stub knobs + a spy loop.
 * Pass a custom knobs impl to share one across the harness under test.
 */
export function fakeGatesController(
  knobs: KnobsHarnessProtocol = stubKnobsHarness(),
): FakeGatesController {
  const loop = spyLoopControl();
  const audits: GateOverrideAudit[] = [];
  const controller = new GatesController({
    knobs,
    loopControl: loop,
    audit: (event) => {
      audits.push(event);
    },
  });
  return {
    controller,
    knobs,
    loop,
    audits,
    tick: (result: TickResult) => controller.handleTickEnd(result),
  };
}
