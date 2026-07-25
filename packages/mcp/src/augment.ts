import type { CommandInfo } from "@agentick/spec";
/**
 * Module augmentation — adds the `mcp` slot to `HookBridges` from
 * `@agentick/spec`.
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
 * `@agentick/mcp`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Reference a type from `@agentick/spec` so TypeScript treats it as
// an external module declaration target — `declare module "..."` won't
// resolve unless the module has been imported in this file.
import type { HookBridges as _HookBridges } from "@agentick/spec";

import type { McpHookBridge } from "./bridge-types.js";

// Mark the unused import as referenced — keeps `noUnusedLocals` happy.
export type _SpecAugmentReference = _HookBridges;

declare module "@agentick/spec" {
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
     * MCP connection identifier — the per-connection routing dimension
     * for the MCP wire, used on BOTH roles:
     *
     *  - CLIENT (outbound): McpClientHarness operations stamp their
     *    `(session, server)` connection so subscribers filter via
     *    `app.events({ scope: { mcpConnectionId: "..." } })`.
     *  - SERVER (inbound, ADR 64): McpServerHarness stamps each accepted
     *    connection's id on `log` / `progress` signal events so the
     *    per-connection log + progress projections subscribe to exactly
     *    their connection's signals.
     *
     * The two roles never share an id space (client connection ids and
     * server `conn:*` ids are disjoint), and every projection also
     * filters by `surface` + signal name, so the shared dimension name
     * carries no cross-role ambiguity.
     *
     * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
     * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
     */
    readonly mcpConnectionId?: string;
  }
}

// ADR 51 slice 5 (#141) — read/discovery + task status/cancel rows.
// call-tool / call-tool-as-task are NOT exposed (matrix hold: they
// bypass the model loop AND the capability-policy gate).
declare module "@agentick/spec" {
  interface WireMethods {
    "mcp/list_tools": { params: { sessionId: string; serverId: string }; result: unknown };
    "mcp/list_tasks": { params: { sessionId: string; serverId: string }; result: unknown };
    "mcp/get_task": {
      params: { sessionId: string; serverId: string; taskId: string };
      result: unknown;
    };
    "mcp/get_task_result": {
      params: { sessionId: string; serverId: string; taskId: string };
      result: unknown;
    };
    "mcp/cancel_task": {
      params: { sessionId: string; serverId: string; taskId: string };
      result: unknown;
    };
    "mcp/commands": {
      params: { sessionId: string; serverId: string };
      result: { commands: readonly CommandInfo[] };
    };
  }
}
