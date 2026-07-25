/**
 * `@agentick/sandbox/testing` — test doubles + conformance for the
 * `SandboxProvider` contract (ADR 59).
 *
 * The double + the executable contract live WITH the contract they pin:
 * every provider (`sandbox-local-next`, `sandbox-docker-next`, …) deps
 * the base and imports both from here.
 *
 *   - `runSandboxProviderConformance` — the #218 conformance suite; a
 *     provider runs it against a REAL instance to claim conformance.
 *   - `fakeSandboxProvider` — an in-memory fake (Meszaros working impl)
 *     for wiring harness/bridge integration without real processes.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

export {
  runSandboxProviderConformance,
  type SandboxProviderConformanceOptions,
} from "./conformance.js";

export { fakeSandboxProvider, type FakeSandboxOptions } from "./fake.js";
