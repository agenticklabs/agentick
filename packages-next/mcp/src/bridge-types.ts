/**
 * Type for the `bridges.mcp` slot exposed by `withMCP({ servers })`.
 *
 * Lookup by `serverId` returns a typed handle to the per-server
 * `McpClientHarness`. In-tree JSX consumers reach the harness via
 * `useBridges().mcp?.client("linear")` and call
 * `.harness.callTool(...)` directly — though the more common path is
 * to let the model dispatch the auto-registered local tool name
 * (`<serverId>__<toolName>`) through the normal tool-executor.
 *
 * The `clients` array gives bulk access for surfaces that want to
 * enumerate (status dashboards, health UIs).
 */

import type { McpClientHandle } from "./integration/with-mcp.js";

export interface McpHookBridge {
  /** Look up a client by server id. Returns undefined if not registered. */
  readonly client: (serverId: string) => McpClientHandle | undefined;
  /** All registered clients (snapshot — not reactive). */
  readonly clients: ReadonlyArray<McpClientHandle>;
}

export type { McpClientHandle };
