/**
 * @agentick/spec-conformance — internal conformance fixtures.
 *
 * The executable form of the pluggability charter. Any implementation
 * of an `@agentick/spec` protocol interface passes the matching suite
 * to claim conformance.
 *
 * @see docs/proposals/v2/blueprint/20-pluggability-charter.md
 */

// Substrate protocols (Phase 2)
export { runJournalConformance } from "./journal.js";
export { runEventBusConformance } from "./event-bus.js";
export { runInboxConformance } from "./inbox.js";
export { runHarnessConformance } from "./harness.js";

// Reconciler harness (Phase 3.14)
export {
  runReconcilerConformance,
  type ReconcilerConformanceFactory,
  type ElementInput,
} from "./reconciler.js";

// Bridge conformance (Phase 3.14)
export { runDataBridgeConformance } from "./data-bridge.js";
export { runKnobBridgeConformance } from "./knob-bridge.js";
export { runTimelineBridgeConformance } from "./timeline-bridge.js";
export { runLoopBridgeConformance } from "./loop-bridge.js";

// Renderer / formatter protocols (Phase 4a — formatter harness)
export { runRendererConformance } from "./renderer.js";

// Tool executor (Phase 4a.2)
export {
  runToolExecutorConformance,
  type ToolExecutorConformanceFactory,
  type FixtureToolSpec,
} from "./tool-executor.js";

// Executor harness (Phase 4b.2)
export {
  runExecutorConformance,
  type ExecutorConformanceFactory,
  type ExecutorConformanceFactoryInput,
} from "./executor.js";

// Loop executor (Phase 4d.2)
export {
  runLoopExecutorConformance,
  type LoopExecutorConformanceFactory,
  type LoopExecutorConformanceFactoryInput,
} from "./loop-executor.js";

// Session harness (Phase 4e.2)
export {
  runSessionConformance,
  defaultSessionConformanceDeps,
  type SessionConformanceFactory,
  type SessionConformanceFactoryInput,
  type SessionConformanceFactoryDeps,
} from "./session-harness.js";
