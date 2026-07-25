/**
 * Run the harness conformance suite against `fakeCredentialsHarness`,
 * pinning that the real `CredentialsHarness` + in-memory adapter
 * satisfies the substrate contract.
 */

import { runCredentialsHarnessConformance } from "../harness-conformance.js";
import { fakeCredentialsHarness } from "../testing/index.js";

runCredentialsHarnessConformance({
  label: "fakeCredentialsHarness (in-memory adapter)",
  factory: async () => {
    const bundle = fakeCredentialsHarness();
    return { harness: bundle.harness, store: bundle.store };
  },
});
