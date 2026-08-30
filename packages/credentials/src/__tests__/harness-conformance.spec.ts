/**
 * Run the harness conformance suite against `fakeCredentialsHarness`,
 * pinning that the real `CredentialsHarness` + in-memory adapter
 * satisfies the substrate contract.
 */

import { runCredentialsHarnessConformance } from "../harness-conformance.js";
import { fakeCredentialsHarness } from "../testing/index.js";

runCredentialsHarnessConformance({
  label: "fakeCredentialsHarness (ephemeral in-memory provider)",
  factory: async () => {
    const bundle = fakeCredentialsHarness();
    return { harness: bundle.harness, provider: bundle.providers[0]! };
  },
});
