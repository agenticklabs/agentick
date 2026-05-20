/**
 * `@agentick/tool` — generic, reconciler-agnostic tool authoring.
 *
 * `createTool(spec)` returns a `{ declaration, handlerRef, handler,
 * validator }` bundle ready to register with any tool executor.
 *
 * Depends only on `@agentick/spec`. Reconciler-specific variants
 * (e.g., `@agentick/reconciler-react` with a `use()` hook) extend
 * this factory.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

export { createTool, type ToolSpec, type CreatedTool } from "./create-tool.js";
export { permissiveValidator, fromStandardSchema } from "./validator.js";
