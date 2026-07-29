/**
 * @agentick/spec-conformance — internal conformance fixtures.
 *
 * The executable form of the pluggability charter. Any implementation
 * of an `@agentick/spec` protocol interface passes the matching suite
 * to claim conformance.
 *
 * @see docs/proposals/v2/blueprint/20-pluggability-charter.md
 */

// AgentickError class hierarchy (ADR 41)
export { runAgentickErrorConformance, type AgentickErrorConformanceFactory } from "./errors.js";

// Unified ToolHandlerCtx test fixture (ADR 43)
export { fakeToolHandlerCtx, type FakeToolHandlerCtxOverrides } from "./fake-tool-handler-ctx.js";

// Observability facet (ADR 64/78) — cross-surface ctx conformance
export { runObservabilityCtxConformance, type ObservabilityCtxFactory } from "./observability.js";

// Ops facet (ADR 19/83) — `ctx.run` + `ctx.runner` cross-surface conformance
export { runOpsCtxConformance, type OpsCtxFactory } from "./ops.js";

// Substrate protocols (Phase 2)
export { runJournalConformance } from "./journal.js";
export { runEventBusConformance } from "./event-bus.js";
export { runInboxConformance } from "./inbox.js";
export { runHarnessConformance } from "./harness.js";

// Slot trichotomy (ADR 42 Slice 4)
export { runHarnessSlotConformance, type HarnessSlotConformanceOptions } from "./harness-slot.js";

// Compiler harness (Phase 3.14)
export {
  runCompilerConformance,
  type CompilerConformanceFactory,
  type ElementInput,
} from "./compiler.js";

// Bridge conformance (Phase 3.14). Knobs / state / timeline are
// harnesses (ADR 26); their conformance suites ship from their
// respective packages (`runKnobsHarnessConformance` from
// `@agentick/knobs`, etc.), not here.
export { runDataBridgeConformance } from "./data-bridge.js";
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

// NOTE: `runMediaDeclarationCheck` lives in `@agentick/model/testing`, not here. It
// checks a declaration against an adapter's real wire projection, which needs
// `detectDroppedInputs` from @agentick/model — and this package is spec + utils only by
// design, since it certifies SPEC protocols rather than one layer's implementations.
// What stays here is the part that is genuinely spec-level: declaration/supportsVision
// coherence, inside `runExecutorConformance`.

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

// Wire conformance (Phase 33.A) — every transport runs this against
// its native codec to prove frames round-trip and the validator accepts
// what the transport produces.
export { runWireConformance, type WireCodec } from "./wire.js";

// Transport conformance (Phase 33.C.1) — every ClientTransport impl
// runs this behavioral suite to prove state-machine transitions, RPC
// correlation, subscription multiplexing, notification routing, and
// cancellation emit. Wire-specific tests (subprotocol, peer creds,
// HTTP topology) live in the per-transport package.
export {
  runTransportConformance,
  type TransportConformanceFactory,
  type TestHandler,
} from "./transport.js";

// ServerTransport conformance (ADR 84 §2) — the symmetric server-side
// counterpart. Every `ServerTransport` impl runs this to prove listen/close
// bind + teardown + idempotency. The gateway relies on this contract when it
// fans out `transport.listen(this)` / `transport.close()`.
export {
  runServerTransportConformance,
  type ServerTransportConformanceFactory,
} from "./server-transport.js";
