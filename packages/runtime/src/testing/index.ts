/**
 * `@agentick/runtime/testing` — substrate test doubles.
 *
 * The FAKE tier is the production in-memory substrate itself — import
 * `LocalInbox` / `LocalEventBus` / `MemoryJournal` from the package
 * root (real routing, real semantics; Meszaros fakes). This subpath
 * holds the STUB/SPY tier: canned answers + call recording, no
 * routing. Doubles are typed against spec interfaces so spec changes
 * break stale doubles at compile time.
 */

export { stubInbox, type StubInboxCall, type StubInboxOptions } from "./stub-inbox.js";
export {
  spyTelemetryProvider,
  type SpyTelemetryProvider,
  type RecordedMetric,
  type RecordedSpan,
} from "./spy-telemetry-provider.js";
export {
  spyTelemetrySink,
  type SpyTelemetrySink,
  type RecordedSinkMetric,
} from "./spy-telemetry-sink.js";
export { deriveTestContext } from "./derive-test-context.js";
