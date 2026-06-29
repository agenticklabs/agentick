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

import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { CreatedTool } from "@agentick/tool-next";

import { McpServerHarness, type McpServerHarnessOptions } from "./harness.js";
import type { ToolHandlerResolver } from "./projection/tools.js";

/**
 * Input to {@link spawnStandaloneMcpServer}. A superset of
 * `McpServerHarnessOptions`:
 *
 *  - `tools` accepts EITHER the harness's raw `{ registry,
 *    resolveHandler }` shape, OR a more ergonomic `CreatedTool[]`
 *    array (the return values of `createTool({...})` calls). The
 *    array form is auto-converted into a registry + resolver.
 *
 *  - `scopeId` overrides the default `srv:<ulid>` for tests + custom
 *    naming.
 */
export interface SpawnStandaloneOptions extends Omit<McpServerHarnessOptions, "tools"> {
  readonly tools?: McpServerHarnessOptions["tools"] | readonly CreatedTool[];
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
  const scopeId = options.scopeId ?? `srv:${ulid()}`;

  const tools = normalizeTools(options.tools);

  const harnessOptions: McpServerHarnessOptions = {
    config: options.config,
    ...(options.transports ? { transports: options.transports } : {}),
    ...(tools ? { tools } : {}),
    ...(options.serverInfo ? { serverInfo: options.serverInfo } : {}),
  };
  const harness = new McpServerHarness(scopeId, journal, bus, inbox, harnessOptions);
  await harness.ready;
  await harness.start();
  return {
    harness,
    close: () => harness.close(),
  };
}

/**
 * Accept either the harness's raw `{ registry, resolveHandler }`
 * shape or a `CreatedTool[]` array. Adopters pass whichever is
 * convenient; the spawn shim handles the conversion.
 */
function normalizeTools(
  tools: SpawnStandaloneOptions["tools"],
): McpServerHarnessOptions["tools"] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) {
    return tools as McpServerHarnessOptions["tools"];
  }
  const created = tools as readonly CreatedTool[];
  const registry = created.map((c) => c.declaration);
  const handlersByRef = new Map<string, CreatedTool["handler"]>();
  for (const t of created) handlersByRef.set(t.handlerRef, t.handler);
  const resolveHandler: ToolHandlerResolver = (ref) => {
    const h = handlersByRef.get(ref);
    if (!h) return null;
    // ToolHandler from @agentick/spec-next has signature
    // (input, { ctx, use }) => ToolHandlerResult. The MCP projection
    // wants (input, mcpCtx) => Promise<ContentBlock[]>. Mode A MVP
    // passes a stub ctx — adopters running fully-isolated Mode A use
    // simple tools that don't read ctx. Richer ctx-bridge (sendProgress,
    // signal forwarding, tasks/elicitation passthrough) lands when
    // gateway integration arrives.
    return async (input) => {
      const result = await h(input, { ctx: createStubHandlerCtx(), use: {} });
      // ToolHandlerResult can be ContentBlock[] OR Promise/Effect/Task.
      // The MVP only supports the sync ContentBlock[] return; richer
      // shapes need ctx integration that doesn't exist in Mode A yet.
      if (Array.isArray(result)) return result;
      // TODO(#171-spawn): Mode A standalone needs ctx-bridge for
      // Promise / Effect / TaskHandle handler returns + ctx.tasks /
      // ctx.elicitation. Lands when gateway integration arrives.
      throw new Error(
        "spawnStandaloneMcpServer: tool handlers must return ContentBlock[] synchronously in Mode A MVP. " +
          "Async / Effect / TaskHandle returns need gateway-side ctx integration (#171 follow-up).",
      );
    };
  };
  return { registry, resolveHandler };
}

/**
 * Minimal `ToolHandlerCtx` stub for standalone-mode dispatch. None of
 * its fields are populated — adopters in Mode A pass tools that don't
 * read ctx.
 *
 * TODO(#171-spawn): wire a real ctx adapter that bridges
 * `McpRequestContext` ↔ `ToolHandlerCtx` so adopters can write tools
 * that observe identity / signal / sendProgress in Mode A.
 */
function createStubHandlerCtx(): import("@agentick/spec-next").ToolHandlerCtx {
  return {
    toolCallId: "standalone",
    sessionId: "standalone",
    executionId: "standalone",
    signal: new AbortController().signal,
    emit: () => {},
    services: {},
  } as unknown as import("@agentick/spec-next").ToolHandlerCtx;
}
