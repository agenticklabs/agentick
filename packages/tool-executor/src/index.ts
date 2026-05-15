/**
 * @agentick/tool-executor — reference tool executor harness.
 *
 * Reference implementation of `ToolExecutorProtocol` from
 * `@agentick/spec`. The harness owns the tool registry, validates
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

// Registry
export { InMemoryToolRegistry } from "./registry.js";

// Handler resolver
export { InMemoryHandlerResolver } from "./handler-resolver.js";

// Validators
export { permissiveValidator, fromStandardSchema } from "./validator.js";

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
