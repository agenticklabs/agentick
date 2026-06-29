/**
 * `McpServerHandle` — curated read surface exposed on the gateway as
 * `gateway.mcpServers.get(name)`.
 *
 * Hides construction + close + internal projection wiring. Adopters
 * observing server state (active connections, lifecycle changes) reach
 * for the handle; framework code working with the harness directly
 * uses {@link McpServerHarness}.
 */

import type {
  McpServerConnectionInfo,
  McpServerHarnessProtocol,
  Unsubscribe,
} from "@agentick/spec-next";

export interface McpServerHandle {
  /** Server's name from `McpServerConfig.name`. */
  readonly name: string;
  /** Snapshot the currently-open connections. */
  readonly connections: () => readonly McpServerConnectionInfo[];
  /** Subscribe to connection lifecycle changes. */
  readonly onConnectionChange: (listener: () => void) => Unsubscribe;
  /** Direct-projection handle for in-process clients (lands with #171g). */
  readonly asClient: () => unknown;
}

/**
 * Project an `McpServerHarnessProtocol` to the public handle. Used at
 * gateway construction time when populating the `mcpServers` registry.
 *
 * Structural projection — the harness already satisfies the handle
 * shape, so this is mostly a type narrowing exercise. Kept as a
 * function (vs. cast) so future divergence (e.g., adding access
 * controls on the handle) has a single place to land.
 */
export function toHandle(harness: McpServerHarnessProtocol): McpServerHandle {
  return {
    name: harness.name,
    connections: () => harness.connections(),
    onConnectionChange: (listener) => harness.onConnectionChange(listener),
    asClient: () => harness.asClient(),
  };
}
