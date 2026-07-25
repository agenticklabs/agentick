/**
 * `@agentick/tool-executor/client` — the client-side client-tool surface.
 *
 * ONE handle, `session.clientToolCalls`, on the `ClientHandle` contract — the
 * inbound tool-call feed (`list()` the pending calls, `subscribe(cb)`, reply by
 * `respond(id, result)` or a listed item's `.respond(result)`) PLUS the folded
 * control verbs:
 *
 *   - `.set(declarations)` — DECLARE the client's full tool set (a whole-slice
 *     replace) over `session/set_client_tools`.
 *   - `.route(handlers, opts?)` — the ergonomic router: dispatch → auto-respond.
 *   - `.confirm(policy)` — approve/deny/predicate over `tool_confirmation`
 *     elicitations.
 *
 * The once-loose session slots (`setClientTools`, `routeClientTools`,
 * `confirmClientTools`) are GONE — folded onto the handle as `.set`/`.route`/
 * `.confirm` (Ryan's Q1a, pre-1.0, no deprecation). `respondToToolCall` survives
 * as the by-id escape-hatch free function (twin of `respondToElicitation`), for
 * code holding a bare `correlationId` outside the handle's pending set.
 *
 * Depends on `@agentick/client-core` (the sub-handle registry) + spec types
 * (+ `@agentick/elicitation/client` for `.confirm`) — NOT on the
 * tool-executor harness runtime. Mirrors the elicitation/tasks/knobs `/client`
 * convention.
 */

export {
  clientToolCallsHandle,
  respondToToolCall,
  type ClientToolCall,
  type ClientToolCallHandle,
  type ClientToolCallsClient,
  type ClientToolCallsHandle,
  type ClientToolHandler,
  type RouteClientToolsOptions,
} from "./client-tool-calls.js";
export { type ConfirmPolicy, type ConfirmRequest } from "./confirm.js";

// `session.tools` — the tool registry projection (three-audiences-plan §F).
export { toolsHandle, type ToolsClientHandle, type ToolsCommandClient } from "./tools-handle.js";

// Side-effect: type the slot (declare module) + register the runtime factory.
// TWO registrations — `clientToolCalls` (inbound feed) and `tools` (registry).
import "./register.js";
import "./tools-register.js";
