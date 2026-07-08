/**
 * `@agentick/sandbox-next/mcp` — opt-in sandbox ↔ MCP/resources adapters
 * (ADR 65). Deps `@agentick/mcp-next` + `@agentick/resources-next`; the
 * dep points sandbox → mcp/resources (one direction, no cycle), keeping
 * the MCP client core decoupled from the sandbox.
 *
 * Two projections, composed over primitives that already exist:
 *   - roots (outbound): {@link sandboxRootsSource} + {@link bindSandboxRootsToClient}
 *   - files (read):     {@link sandboxFileResolver} / {@link fsFileResolver}
 *                       + {@link registerFileResolver}
 *
 * The inbound direction (a connecting client's roots on `ctx.mcp.clientRoots`)
 * needs no sandbox and lives in `@agentick/mcp-next`'s server harness.
 *
 * @see docs/proposals/v2/blueprint/65-roots-as-projection.md
 */

export { sandboxRootsSource, bindSandboxRootsToClient } from "./roots.js";
export {
  sandboxFileResolver,
  fsFileResolver,
  registerFileResolver,
  FILE_URI_TEMPLATE,
} from "./file-resolver.js";
export { pathToFileUri, fileUriFromPath, guessMimeType, isTextMime } from "./uri.js";
