/**
 * `InMemorySessionStore` conformance (E11) — validates the bundled default
 * against the shared {@link runSessionStoreConformance} suite (round-trip,
 * upsert, app/status/parent/recency filtered list, enumerate-all, delete,
 * prune-of-closed). A `@agentick/session-store-postgres` runs the SAME
 * suite later.
 */

import { runSessionStoreConformance } from "../session-store-conformance.js";
import { InMemorySessionStore } from "../session-store.js";

runSessionStoreConformance({
  label: "InMemorySessionStore",
  factory: () => new InMemorySessionStore(),
});
