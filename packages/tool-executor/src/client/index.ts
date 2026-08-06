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
 *   - `.use(tools, opts?)` — declare AND route a set of `createClientTool` tools,
 *     which cannot drift apart because the declaration is projected from the
 *     object that carries the handler.
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
export { toolConfirmation, type ConfirmPolicy, type ConfirmRequest } from "./confirm.js";

// `createClientTool` — the declaration and the handler as ONE object, so the two
// halves cannot be authored apart. `session.clientToolCalls.use(tools)` declares
// and routes them in one call; `dispatchClientToolCall`/`routeClientTools` are
// the consumer for code driving its own feed.
export {
  createClientTool,
  toClientToolDeclaration,
  type ClientTool,
  type ClientToolAcceptCtx,
  type ClientToolCtx,
  type ClientToolCtxExtensions,
  type ClientToolOrigin,
} from "./create-client-tool.js";
export {
  DECLINED,
  dispatchClientToolCall,
  routeClientTools,
  type ClientToolOutcome,
  type ClientToolSelf,
  type ClientToolCallFeed,
  type UseClientToolsOptions,
} from "./use-client-tools.js";

// The confirmation CONTRACT, for a client rendering its own confirm dialog rather
// than handing the decision to `.confirm(policy)`. `toolConfirmation(elic)` is the
// READER — narrows an elicitation off `session.elicitations` to a `ConfirmRequest`
// (or `undefined`), so an app renders toolName/arguments/message/preview without
// re-deriving the mapping. `TOOL_CONFIRMATION_KIND` is the underlying `hints.kind`
// discriminator, for code that wants the raw key.
// `ToolConfirmationReply` types the value `accept(...)` must carry.
export { TOOL_CONFIRMATION_KIND, type ToolConfirmationReply } from "../confirmation-schema.js";

// The client-tool-call channel names + frame shapes — same reason, for a client
// that subscribes or folds frames itself instead of using the handle. The client
// half already imports this module at runtime, so no new graph edge.
export {
  TOOL_CALL_CHANNEL,
  TOOL_CALL_CHANNEL_FQN,
  type PendingToolCall,
  type ToolCallRequestPayload,
  type ToolCallResponse,
  type ToolCallSnapshotFrame,
} from "../tool-call-schema.js";

// `session.tools` — the tool registry projection (three-audiences-plan §F).
export { toolsHandle, type ToolsClientHandle, type ToolsCommandClient } from "./tools-handle.js";

// Side-effect: type the slot (declare module) + register the runtime factory.
// TWO registrations — `clientToolCalls` (inbound feed) and `tools` (registry).
import "./register.js";
import "./tools-register.js";
