/**
 * `@agentick/session-next` — reference session harness.
 *
 * The integration site that wires JSX agent + reconciler + loop
 * executor into the user-facing `session.send({ messages })` surface.
 *
 * @see docs/proposals/v2/blueprint/08-session-harness.md
 */

export { SessionHarness, type SessionHarnessOptions } from "./harness.js";
export { SessionRuntime } from "./session-state.js";
export { defineSession, type DefineSessionInput } from "./define-session.js";
// E11 — the durable session registry / resume index. The `SessionStore` port +
// record + query live in spec-next; the bundled in-memory default + its
// conformance suite ship here (mirrors `InMemoryTaskStore` in tasks-next). A
// `@agentick/session-store-postgres-next` conforms to the SAME port later.
export { InMemorySessionStore } from "./session-store.js";
export {
  runSessionStoreConformance,
  type SessionStoreConformanceOptions,
} from "./session-store-conformance.js";
// Re-export the ports from the same package as the bundled impl so store
// adapters get the contract + reference from one dep.
export type { SessionRecord, SessionStore, SessionStoreQuery } from "@agentick/spec-next";
