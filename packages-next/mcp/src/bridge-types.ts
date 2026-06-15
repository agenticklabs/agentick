/**
 * Placeholder types for the `bridges.mcp` slot.
 *
 * The full `McpHookBridge` interface lands in McpClientHarness #2 once
 * the harness shape is concrete. Today this is an empty marker so the
 * augment.ts side-effect import compiles and adopters can type-check
 * against the slot's presence (`bridges.mcp` is `McpHookBridge |
 * undefined`).
 *
 * When the harness exists, this file gains:
 *   - `McpHookBridge.client(serverId): McpClientHandle`
 *   - `McpHookBridge.clients: ReadonlyArray<McpClientHandle>`
 *   - `McpClientHandle` typed surface (callTool, listTools, etc.)
 */

export interface McpHookBridge {
  /**
   * Reserved for the per-server client lookup, e.g.
   * `bridges.mcp.client("linear").callTool(...)`. Returns `undefined`
   * today; replaced with a real handle in McpClientHarness #2.
   */
  readonly client?: (serverId: string) => unknown;
}
