/**
 * The `agentick` oxlint JS plugin — the house rules.
 *
 * One rule per file under `rules/`; this file only aggregates. See
 * `lint/README.md` for how a bad pattern becomes a rule here.
 */

import noFloatingRunPromise from "./rules/no-floating-run-promise.mjs";

const plugin = {
  meta: { name: "agentick" },
  rules: {
    "no-floating-run-promise": noFloatingRunPromise,
  },
};

export default plugin;
