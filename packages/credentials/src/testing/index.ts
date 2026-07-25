/**
 * `@agentick/credentials/testing` — test doubles.
 *
 * Per the Meszaros taxonomy in the project memory:
 *   - `fake*` — working impl, in-memory substrate (default)
 *   - `stub*` — canned answers, no real round-trip
 *
 * Production tests of consumer code (`withMCP`, future adopter code)
 * should prefer `fakeCredentialsHarness()` — it exercises the real
 * harness over an in-memory store, so consumers exercise the same
 * code path the runtime hits at production-time.
 *
 * `stubCredentialsStore` is for the narrower case where the test
 * cares only about what the consumer does WITH the credential and
 * not about persistence behavior.
 */

export {
  fakeCredentialsHarness,
  type FakeCredentialsOptions,
  type FakeCredentialsBundle,
} from "./fake-credentials.js";

export {
  stubCredentialsStore,
  unavailableCredentialsStore,
  type StubCredentialsStoreOptions,
} from "./stub-credentials-store.js";

// Re-export the in-memory store as `fakeCredentialsStore` for adopters
// who want a working-impl store double without the full harness bundle.
export { inMemoryCredentialsStore as fakeCredentialsStore } from "../stores/in-memory.js";

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export {
  runCredentialsStoreConformance,
  type CredentialsStoreConformanceOptions,
} from "../conformance.js";
export {
  runCredentialsHarnessConformance,
  type CredentialsHarnessConformanceOptions,
} from "../harness-conformance.js";
