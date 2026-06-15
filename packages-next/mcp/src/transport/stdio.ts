/**
 * Stdio transport — re-exports the SDK's `StdioClientTransport` and
 * `StdioServerParameters` from a stable agentick path so adopters
 * don't have to deep-import into the MCP SDK.
 *
 * **Why not wrap?** The SDK's stdio transport implements the
 * `Transport` interface the harness consumes directly. Wrapping
 * would add overhead without buying us anything — there's no v2-
 * specific concern stdio needs to honor that the SDK doesn't already.
 *
 * Adopters supply the subprocess command + args via
 * `StdioServerParameters`; the harness wraps the result in its
 * Transport / Auth / Protocol / Lifecycle stack.
 *
 * ```ts
 * import { StdioClientTransport } from "@agentick/mcp-next";
 *
 * const transport = new StdioClientTransport({
 *   command: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-filesystem", "/some/path"],
 * });
 * ```
 */

export {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
