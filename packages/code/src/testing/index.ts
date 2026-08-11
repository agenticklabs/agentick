/**
 * `@agentick/code/testing` — doubles for consumers of the code harness.
 *
 *   - {@link fakeCode}        a working in-memory `Runtime` (recorded
 *                             instructions, not a JavaScript evaluator).
 *   - {@link fakeCodeProbe}   its conformance probe.
 *   - {@link fakeCodeHarness} the real harness on an in-memory substrate.
 */

export { fakeCode, fakeProgram, type FakeCodeOptions, type FakeInstruction } from "./fake-code.js";
export { fakeCodeProbe, fakeCodeSource } from "./fake-code-probe.js";
export {
  fakeCodeHarness,
  type FakeCodeHarnessBundle,
  type FakeCodeHarnessOptions,
} from "./fake-code-harness.js";

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export {
  runCodeConformance,
  type CodeConformanceProbe,
  type CodeSourceVocabulary,
} from "../conformance.js";
