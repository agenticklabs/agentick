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
