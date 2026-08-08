/**
 * `spawnStandaloneMcpServer` — Mode A entry point.
 *
 * Synthesizes a minimal substrate (in-memory journal/bus/inbox) +
 * `McpServerHarness`, mounts the configured transports, starts
 * accepting connections, returns a handle the caller can `close()`.
 *
 * This is the Mode A counterpart to gateway-extension mounting
 * (Mode B). The harness implementation is identical between modes —
 * only the surrounding shell differs.
 *
 * **Scope (#171c).** No cluster, no app-spawning, no gateway shell —
 * a single in-process server. Adopters who want multi-process /
 * clustered deployments use Mode B via `createGateway({ mcpServers })`
 * when that lands (currently filed as a top-level slot per ADR 40 §2;
 * actual wiring follows from #254 + gateway integration).
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md §10
 */

import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";

import type { McpServerOptions } from "./config.js";
import { McpServerHarness } from "./harness.js";

/**
 * Input to {@link spawnStandaloneMcpServer}. A superset of
 * `McpServerOptions` with one optional override:
 *
 *  - `scopeId` overrides the default `srv:<id>` for tests + custom
 *    naming.
 *
 * The `tools` field accepts the same trichotomic
 * {@link McpServerToolsOptions} shape as the harness itself (per ADR
 * 42 Slice 2). The array shorthand `tools: [Calculator, ...]` is the
 * common case — the harness builds the internal registry + handler
 * resolver from each `CreatedTool`.
 */
export interface SpawnStandaloneOptions extends McpServerOptions {
  readonly scopeId?: string;
}

/**
 * Handle returned by {@link spawnStandaloneMcpServer}. Adopters
 * `close()` for graceful shutdown.
 */
export interface StandaloneServerHandle {
  readonly harness: McpServerHarness;
  /** Close the server + drain in-flight connections. Idempotent. */
  readonly close: () => Promise<void>;
}

/**
 * Spawn an MCP server in a minimal standalone shell. Returns a handle
 * the caller manages — does NOT install signal handlers (callers wire
 * those at the bin layer where intent + main-thread context are clear).
 */
export async function spawnStandaloneMcpServer(
  options: SpawnStandaloneOptions,
): Promise<StandaloneServerHandle> {
  const journal = new MemoryJournal({ capacity: 4096 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const scopeId = options.scopeId ?? `srv:${generateId()}`;

  const { scopeId: _drop, ...harnessOptions } = options;
  void _drop;

  const harness = new McpServerHarness(scopeId, journal, bus, inbox, harnessOptions);
  await harness.ready;
  await harness.start();
  return {
    harness,
    close: () => harness.close(),
  };
}
