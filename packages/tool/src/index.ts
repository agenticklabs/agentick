/**
 * `@agentick/tool` — generic, compiler-agnostic tool authoring.
 *
 * `createTool(spec)` returns a `{ declaration, handlerRef, handler,
 * validator }` bundle ready to register with any tool executor.
 *
 * Depends only on `@agentick/spec`. Compiler-specific variants
 * (e.g., `@agentick/compiler-react` with a `use()` hook) extend
 * this factory.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

export { createTool, isCreatedTool, type ToolSpec, type CreatedTool } from "./create-tool.js";
export { permissiveValidator, fromStandardSchema } from "./validator.js";
export {
  createToolCatalog,
  isToolCatalog,
  staticToolCatalog,
  type MutableToolCatalog,
  type ToolCatalog,
} from "./catalog.js";
