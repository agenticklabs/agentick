/**
 * @agentick/timeline — TimelineHarness extraction (ADR 26 Step 5a).
 *
 * Private workspace package. Bundled into the `agentick` metapackage;
 * not published independently. Adopters consume `withTimeline()` +
 * `TimelineHarness` via the metapackage.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

export { TimelineHarness } from "./harness.js";
export { withTimeline, type WithTimelineOptions } from "./extension.js";
export { withHandler, type WithHandlerOptions } from "./strategies.js";
export { runTimelineHarnessConformance } from "./conformance.js";
