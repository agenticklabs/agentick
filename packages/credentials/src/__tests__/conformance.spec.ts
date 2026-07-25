/**
 * Run the conformance suite against bundled adapters. Adopter
 * adapter packages run their own copy of the suite against their
 * own factory.
 */

import { envCredentialsStore, inMemoryCredentialsStore } from "../index.js";
import { runCredentialsStoreConformance } from "../conformance.js";

runCredentialsStoreConformance({
  label: "inMemoryCredentialsStore",
  factory: () => inMemoryCredentialsStore(),
});

// Env store mutates `process.env` — give each suite run an isolated
// prefix so subscribers + keys() don't see leftover entries from
// other test files.
let envPrefixCounter = 0;

runCredentialsStoreConformance({
  label: "envCredentialsStore (writable=true)",
  factory: () =>
    envCredentialsStore({ prefix: `AGENTICK_TEST_${++envPrefixCounter}`, writable: true }),
  capabilities: {
    // process.env mutations don't emit native change events; the
    // env adapter doesn't implement onChange.
    reactivity: false,
  },
});
