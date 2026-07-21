/**
 * `@agentick/tool-executor-next/client` — the client-side client-tool surface.
 *
 * Two layers, both harness-runtime-free (out of the browser bundle):
 *
 *   - **Write verbs (stage 2)** — `session.setClientTools(declarations)`
 *     (DECLARE the client's full tool set — a whole-slice replace) and
 *     `session.respondToToolCall(correlationId, result)` (relay a tool-call
 *     result), riding `session/set_client_tools` / `session/respond_to_tool_call`.
 *   - **Consumer + policy (stage 3)** — `session.clientToolCalls` (the inbound
 *     tool-call feed), `session.routeClientTools(handlers, opts?)` (the
 *     ergonomic router: dispatch → auto-respond), and
 *     `session.confirmClientTools(policy)` (approve/deny/predicate over
 *     `tool_confirmation` elicitations).
 *
 * Depends on `@agentick/client-core-next` (the sub-handle registry) + spec
 * types (+ `@agentick/elicitation-next/client` for the confirmation stream) —
 * NOT on the tool-executor harness runtime. Mirrors the elicitation/tasks/knobs
 * `/client` convention.
 *
 * Importing this subpath contributes all five members to the client
 * `SessionHandle` (ADR 87).
 */

export {
  clientToolCallStream,
  respondToToolCall,
  routeClientTools,
  type ClientToolCall,
  type ClientToolCallHandle,
  type ClientToolCallsHandle,
  type ClientToolHandler,
  type RouteClientToolsOptions,
} from "./client-tool-calls.js";
export { confirmClientTools, type ConfirmPolicy, type ConfirmRequest } from "./confirm.js";

// Side-effect: type the slots (declare module) + register the runtime factories.
import "./register.js";
