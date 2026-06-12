/**
 * `@agentick/client-telemetry-next` — telemetry middleware for
 * `@agentick/client-next`. OpenTelemetry-shaped: span per logical RPC,
 * W3C Trace Context propagation via the MCP `_meta` slot, OTel RPC
 * semantic conventions.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/
 * @see https://www.w3.org/TR/trace-context/
 */

export {
  telemetry,
  noopAdapter,
  type TelemetryOptions,
  type TelemetryAdapter,
  type TelemetrySpan,
} from "./telemetry.js";
export { recordTraceContext, generateTraceparent } from "./trace-context.js";
