/**
 * Module augmentation — adds the `mcp` slot to `HookBridges` from
 * `@agentick/spec-next`.
 *
 * The slot's value is filled in by McpClientHarness #2 — a
 * `Map<serverId, McpClientHarnessProtocol>` (or equivalent) exposing
 * the per-server clients to in-tree consumers via
 * `useBridges().mcp.client("linear")`.
 *
 * For now (the skeleton commit) the augmentation registers an empty
 * placeholder type — the slot is typed but unused. The McpClientHarness
 * + withMCP extension land in #2 / #3 and fill it in.
 *
 * Loaded as a side effect when anything imports from
 * `@agentick/mcp-next`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Reference a type from `@agentick/spec-next` so TypeScript treats it as
// an external module declaration target — `declare module "..."` won't
// resolve unless the module has been imported in this file.
import type { HookBridges as _HookBridges } from "@agentick/spec-next";

import type { McpHookBridge } from "./bridge-types.js";

// Mark the unused import as referenced — keeps `noUnusedLocals` happy.
export type _SpecAugmentReference = _HookBridges;

declare module "@agentick/spec-next" {
  interface HookBridges {
    /**
     * Per-app MCP client registry. Keyed by server id (e.g., "linear",
     * "notion", "fs"). Filled in by `withMCP({ servers: [...] })`;
     * absent on apps that don't wire MCP.
     */
    readonly mcp?: McpHookBridge;
  }

  interface EventScopeExtensions {
    /**
     * MCP client connection identifier — populated by McpClientHarness
     * operations so subscribers can filter events to a specific
     * (session, server) connection via
     * `app.events({ scope: { mcpConnectionId: "..." } })`.
     *
     * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
     */
    readonly mcpConnectionId?: string;
  }
}
