/**
 * `@agentick/client-core-next/testing` — the executable contract for client
 * handles plus the spy transport its closures use.
 *
 *   - `runClientHandleConformance` — the B2 conformance suite (`docs/proposals/
 *     v2/client-handles.md` §4). A handle claims conformance by passing it; the
 *     slices-3+ refactors converge each existing handle onto it.
 *   - `spyClientTransport` — a Meszaros spy over `request` + `subscribe`, homed
 *     here so the conformance closures and the handle unit tests share one
 *     double instead of re-rolling `pushStream` per suite.
 *
 * Per ADR 27, the executable contract + its doubles live WITH the contract they
 * pin (here, alongside `handle-contract.ts` in client-core).
 *
 * @see docs/proposals/v2/client-handles.md
 */

export {
  runClientHandleConformance,
  type ClientHandleConformanceContext,
  type ClientHandleConformanceOptions,
  type EnumerableProbe,
  type RespondableProbe,
  type WriteVerbProbe,
} from "./handle-conformance.js";

export {
  spyClientTransport,
  type SpyClientTransport,
  type SpyClientTransportOptions,
  type RecordedRequest,
  type RecordedSubscribe,
} from "./spy-client-transport.js";
