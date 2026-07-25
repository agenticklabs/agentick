/**
 * @agentick/resources/testing — test doubles.
 *
 * Per the Meszaros taxonomy in the project's auto-memory:
 *   fake* = working impl backed by an in-memory substrate (default).
 *   stub* = canned answers, no real round-trip.
 *
 * Production tests of code that *uses* the ResourcesHarness should
 * prefer `fakeResources()` — it exercises the real harness over a memory
 * substrate, so consumers hit the same code path the runtime does at
 * production-time.
 */

export {
  fakeResources,
  type FakeResourcesOptions,
  type FakeResourcesBundle,
} from "./fake-resources.js";
export { stubResources, type StubResourcesOptions } from "./stub-resources.js";

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export { runResourcesHarnessConformance } from "../conformance.js";
export {
  runResourceStoreConformance,
  type ResourceStoreConformanceOptions,
} from "../store-conformance.js";
