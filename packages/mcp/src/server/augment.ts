/**
 * Module augmentation — registers the `mcpServers` slot on
 * `GatewayExtensions`.
 *
 * Per ADR 27 (modular built-ins): every harness package owns its own
 * slot declaration. Side-effect import in
 * `@agentick/mcp/server/index.ts` brings this in; importing the
 * server subpath is what activates the typing.
 *
 * The slot exposes a registry of `McpServerHandle`s keyed by server
 * name. Gateway construction populates it as it instantiates one
 * `McpServerHarness` per `mcpServers: McpServerConfig[]` entry.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md
 */

import type { McpServerHandle } from "./handle.js";

declare module "@agentick/spec" {
  interface GatewayExtensions {
    readonly mcpServers?: {
      readonly get: (name: string) => McpServerHandle | undefined;
      readonly list: () => readonly McpServerHandle[];
    };
  }

  interface EventScopeExtensions {
    /**
     * MCP SERVER harness identifier — populated by inbound MCP
     * server-side operations so subscribers can filter events to a
     * specific exposed server via
     * `gateway.events({ scope: { mcpServerId: "..." } })`.
     *
     * Distinct from `mcpConnectionId` (client-side) — same wire
     * protocol, opposite role.
     *
     * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
     */
    readonly mcpServerId?: string;
  }
}

// Empty export keeps this file an ES module so the `declare module`
// block is treated as augmentation, not ambient.
export {};
