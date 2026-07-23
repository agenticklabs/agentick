/**
 * `@agentick/app-next` — reference app harness.
 *
 * The outermost runtime boundary. Wraps the shared substrate, shared
 * sub-harnesses (compiler, loop, executor), and the session registry
 * behind the ergonomic `createApp(...)` surface.
 *
 * @see docs/proposals/v2/blueprint/09-app-harness.md
 */

export { AppHarness, type AppHarnessOptions } from "./harness.js";
export { createApp, type CreateAppOptions } from "./create-app.js";
export {
  createTelemetry,
  buildTelemetryExport,
  type BuiltTelemetryExport,
} from "./telemetry-wiring.js";
export {
  normalizeTelemetry,
  type NormalizedTelemetry,
  type TelemetryDefaultsConfig,
} from "./telemetry-defaults.js";
export { run, type RunOptions, type RunHandle } from "./run.js";
export { builtinWireExtensions } from "./builtin-wire.js";
