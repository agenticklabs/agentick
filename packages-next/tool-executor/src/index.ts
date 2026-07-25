/**
 * @agentick/tool-executor-next — reference tool executor harness.
 *
 * Reference implementation of `ToolExecutorProtocol` from
 * `@agentick/spec-next`. The harness owns the tool registry, validates
 * inputs against per-tool validators, resolves `handlerRef` to a
 * concrete handler, and runs the dispatch through the canonical
 * BaseHarness phase contract.
 *
 * Phase 4a.4 — happy path + abort + handler errors land here.
 * Confirmation flow, middleware, lifecycle handler hooks, and inbox
 * dispatch are subsequent sub-phases.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

// Harness
export { ToolExecutorHarness } from "./harness.js";

// Callback-style factory (FAÇADE.6)
export { defineToolExecutor, type DefineToolExecutorInput } from "./define-tool-executor.js";

// Registry
export { InMemoryToolRegistry } from "./registry.js";

// `session.tools` host handle (three-audiences-plan §F) — the curated View +
// host-door dispatch + topology subscription over the registry.
export { createToolsHandle, toToolInfo, type ToolsHandleDeps } from "./tools-handle.js";

// Scoped binding lifecycle helper — composes register + cleanup
// around a caller-supplied async body. The canonical adapter at every
// scope boundary (execution, future "step" / "subagent" / "draft" scopes).
export { withScope } from "./with-scope.js";

// Handler resolver
export { InMemoryHandlerResolver } from "./handler-resolver.js";

// Validators
export { permissiveValidator, fromStandardSchema } from "./validator.js";

// Dispatch provenance — maps the dispatch door (`via`) to the operation
// origin stamped at the command gate (ADR 51 §5/§6).
export { viaToOrigin } from "./provenance.js";

// Client-handled tool dispatch — channel + wire contract (stages 2/3
// subscribe to these). Mirror of the elicitation channel export.
export {
  TOOL_CALL_CHANNEL,
  TOOL_CALL_CHANNEL_FQN,
  TOOL_CALL_REQUEST_SCHEMA,
  type PendingToolCall,
  type ToolCallRequestPayload,
  type ToolCallResponse,
  type ToolCallSnapshotFrame,
} from "./tool-call-schema.js";

// Types
export type {
  HandlerEntry,
  HandlerResolver,
  HandlerChannelSeed,
  ToolExecutorHarnessOptions,
  ToolHandler,
  ToolHandlerCtx,
  Validator,
  ValidatorResult,
} from "./types.js";
