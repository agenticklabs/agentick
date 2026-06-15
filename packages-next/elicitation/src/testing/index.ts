/**
 * @agentick/elicitation-next/testing — test doubles.
 *
 * Per the Meszaros taxonomy in the project's auto-memory:
 *   fake* = working impl backed by an in-memory substrate (default).
 *   stub* = canned answers, no real round-trip.
 *
 * Production tests of code that *uses* the ElicitationHarness should
 * prefer `fakeElicitation()` — it exercises the real harness over a
 * memory substrate, so consumers exercise the same code path the
 * runtime hits at production-time.
 */

export { fakeElicitation, type FakeElicitationOptions } from "./fake-elicitation.js";
export { stubElicitation, type StubElicitationOptions } from "./stub-elicitation.js";
