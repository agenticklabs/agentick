/**
 * @agentick/completions/testing — test doubles.
 *
 * Per the Meszaros taxonomy:
 *   fake* = working impl backed by an in-memory substrate (default).
 *   stub* = canned answers, no real round-trip.
 *
 * Tests of code that *uses* the CompletionsHarness should prefer
 * `fakeCompletions()` — it exercises the real harness over a memory substrate, so
 * consumers hit the same derived-ctx code path the runtime does. Reach for
 * `stubCompletions()` only when the system under test consumes the protocol
 * surface and never needs a resolver ctx.
 */

export {
  fakeCompletions,
  type FakeCompletionsOptions,
  type FakeCompletionsBundle,
} from "./fake-completions.js";
export { stubCompletions, type StubCompletionsOptions } from "./stub-completions.js";
export { fakeCompletionCtx, type FakeCompletionCtxOptions } from "./fake-completion-ctx.js";

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export {
  runCompletionsHarnessConformance,
  type CompletionsConformanceFactory,
  type CompletionsConformanceFactoryInput,
  type CompletionsConformanceShell,
} from "../conformance.js";
