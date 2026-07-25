/**
 * `@agentick/tool/transforms` — tool-list transformation primitives.
 *
 * Generic, framework-internal-agnostic library of `ToolTransform<C>`
 * primitives that map / filter / rewrite `ToolDeclaration` lists per
 * arbitrary context. The MCP server projection uses these for
 * per-connection tool views; eval-next uses them for ablation; in-app
 * rebranding uses them for audience-specific descriptions.
 *
 * Two scope rules:
 *
 *  1. Transforms operate on `ToolDeclaration` only. Handler wrapping
 *     requires the registration bundle (`CreatedTool`); that's a
 *     separate primitive (`wrapHandler`, NOT in this module).
 *
 *  2. Semantic annotations (`readOnlyHint` / `destructiveHint` /
 *     `idempotentHint` / `openWorldHint`) and v2's own `annotations`
 *     slot are NOT mutated by any transform shipped here. Lying about
 *     destructiveness per-audience is a safety footgun. See ADR 40 §4.
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md §4
 */

export { applyTransform, composeTransforms, type ToolTransform } from "./transform.js";
export { describe, setIcons, setTitle, type IconDescriptor } from "./describe.js";
export { allow, deny, filter, onlyExposingTo } from "./filter.js";
export { mapSchemas, replaceInputSchema, replaceOutputSchema } from "./schema.js";
export { replaceMetadata, setMetadata } from "./metadata.js";
export { prefix, rename, renameBy, suffix } from "./rename.js";
