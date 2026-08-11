/**
 * The suite against the reference provider — twice, with different capability
 * claims, so both sides of every capability-honesty branch are exercised: a
 * runtime that enforces budgets and carries context state, and one that
 * declares neither and is held to that instead.
 */

import { runCodeConformance } from "../conformance.js";
import { fakeCodeProbe } from "../testing/fake-code-probe.js";

runCodeConformance(fakeCodeProbe());

runCodeConformance(
  fakeCodeProbe({ name: "fakeCode(minimal)", enforces: [], persistentContext: false }),
);
