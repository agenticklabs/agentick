/**
 * `@agentick/compiler/testing` — test doubles for
 * `@agentick/compiler`.
 *
 * Per the Meszaros taxonomy + agentick memory rule:
 *   - `fake*` — minimal working impl (default)
 *   - `stub*` — canned per-call answers (not yet shipped here)
 *   - `mock*` — call-expectations (not yet shipped here)
 *
 * Test doubles are statically typed against spec interfaces — spec
 * changes break this code at compile time. Adopters MUST NOT bypass
 * the spec type by widening to `any` or ad-hoc shapes.
 */

export { fakeCompiler } from "./fake-compiler.js";
export { timelineCompiler } from "./timeline-compiler.js";
export {
  fakeBridges,
  stubLoopBridge,
  stubSessionBridge,
  fakeTimelineHarness,
  fakeKnobsHarness,
  mockStateHarness,
} from "./fake-bridges.js";
export type { FakeBridgesOptions } from "./fake-bridges.js";
