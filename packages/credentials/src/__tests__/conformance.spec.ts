/**
 * The bundled providers against the shared conformance suite.
 *
 * `env` declares itself read-only and non-enumerable-by-write: it reflects the
 * process environment, so a write would mutate this process's view and nothing
 * else. Omitting `set` rather than shipping one that lies is the contract the
 * suite checks.
 */

import { envCredentialProvider, inMemoryCredentialProvider } from "../index.js";
import { runCredentialProviderConformance } from "../conformance.js";

runCredentialProviderConformance({
  label: "inMemoryCredentialProvider",
  factory: () => inMemoryCredentialProvider(),
});

let envPrefixCounter = 0;

runCredentialProviderConformance({
  label: "envCredentialProvider",
  factory: () =>
    envCredentialProvider({
      namespace: "conformance",
      prefix: `AGENTICK_TEST_${++envPrefixCounter}`,
    }),
  capabilities: { writable: false, enumerable: true, reactivity: false },
});
