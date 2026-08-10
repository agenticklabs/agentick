/**
 * `@agentick/session` — reference session harness.
 *
 * The integration site that wires JSX agent + compiler + loop
 * executor into the user-facing `session.send({ messages })` surface.
 *
 * @see docs/proposals/v2/blueprint/08-session-harness.md
 */

export { SessionHarness, type SessionDryRun, type SessionHarnessOptions } from "./harness.js";
export { SessionRuntime } from "./session-state.js";
export type { ReflectInput, ReflectResult } from "./reflect.js";
// ADR 89 §2 — the `session.model` selection / swap facade. The facade
// impl + its handle type ship here; the `SessionHarnessProtocol.model`
// slot is module-augmented onto spec by `./model-facade.js` (loaded via
// the harness import graph).
export {
  SessionModelFacade,
  type ModelSelectionHandle,
  type SetModelInput,
} from "./model-facade.js";
export { defineSession, type DefineSessionInput } from "./define-session.js";
// E11 — the durable session registry / resume index. The `SessionStore` port +
// record + query live in `@agentick/spec`; the bundled in-memory default ships here
// (its conformance suite ships from `./testing`). A
// `@agentick/session-store-postgres` conforms to the SAME port later.
export { InMemorySessionStore } from "./session-store.js";
// Re-export the ports from the same package as the bundled impl so store
// adapters get the contract + reference from one dep.
export type { SessionRecord, SessionStore, SessionStoreQuery } from "@agentick/spec";
// The round-trip recorder (docs/proposals/v2/observability.md) — one artifact
// per TICK spanning compiler → model → provider → timeline. It lives HERE and
// not with the model executor because the span crosses harnesses, and a package
// can only NAME hook keys whose augmenting module is in its compilation. This
// package depends on every harness it integrates, which is why cross-harness
// work belongs here.
export {
  jsonlSink,
  memorySink,
  roundTripRecorder,
  verbatimViolations,
  type PersistedEntry,
  type RoundTrip,
  type RoundTripRecorderOptions,
  type RoundTripScope,
  type RoundTripSink,
  type VerbatimViolation,
} from "./round-trip-recorder.js";
