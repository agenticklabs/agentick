/**
 * `withMCP({ servers })` — `SessionExtension` that wires N MCP server
 * connections PER SESSION + auto-registers each server's discovered
 * tools into the session's ToolExecutor.
 *
 * Per-session architecture (#151) — the architectural floor for MCP
 * in v2. Each (session, server) gets its own `McpClientHarness`:
 *
 *   - **Multi-tenant correct**: MCP binds OAuth tokens, Mcp-Session-Id,
 *     and authorization to the connection. Different users on the
 *     same agentick host MUST have different connections (different
 *     tokens). Sharing connections across users is a wire violation.
 *   - **Concurrent elicits work by construction**: each harness has
 *     a fixed elicit-address (its session's). No slot, no race,
 *     no `mcp:warning:routing-ambiguous` heuristics.
 *   - **Per-session OAuth context**: even same-user-different-sessions
 *     gets isolated auth scopes (debug vs prod, sandbox vs real).
 *
 * ## Lifecycle
 *
 *   1. Each session install runs `withMCP`'s `install(installer)`
 *      against a fresh `SessionInstaller`.
 *   2. For each server config, the extension constructs a per-session
 *      `McpClientHarness` on the shared substrate, with the
 *      installer's elicit harness address fixed at construction.
 *   3. Connects + discovers tools. For each:
 *        a. Registers a handler closure via
 *           `installer.registerToolHandler(handlerRef, handler)`.
 *           handlerRef includes the sessionId to keep registrations
 *           unique across sessions on the shared resolver.
 *        b. Records the tool's declaration + handlerRef via
 *           `installer.registerExtensionTool(...)` with binding
 *           `{ scope: "extension", level: "session" }`.
 *   4. Exposes the per-session clients on the `bridges.mcp` slot via
 *      `installer.registerNamespace("mcp", { client, clients })`.
 *   5. `installer.onClose` cascades — each harness's `close()` runs
 *      when the session closes (NOT when the app closes — each
 *      session owns its connections).
 *
 * ## Connection fan-out
 *
 * N sessions × M servers → N×M connections. Acceptable for
 * HTTP-remote transports (cheap streams). Wasteful for stateless
 * local stdio adapters and for high-tenant deployments.
 *
 * **FUTURE OPTIMIZATION (track in coming weeks)** — connection pool
 * keyed by authentication principal sits BENEATH McpClientHarness
 * via a `connection: McpConnectionRef` indirection. Sessions check
 * connections OUT for the duration of a tick / callTool, back IN
 * when done. Same auth principal → connection sharing; different
 * principals → connection isolation (wire-correct). `Mcp-Session-Id`
 * makes Streamable HTTP cleanly resumable across check-outs. Nothing
 * above this file changes when the pool is introduced. Documented
 * in `packages-next/mcp/README.md` "Connection lifecycle" and
 * `blueprint/23-mcp-as-harness.md`. Defer until production load
 * demands it.
 *
 * ## Failure modes
 *
 *   - A server failing to connect for a given session is recorded
 *     but doesn't abort the rest of that session's servers — the
 *     lifecycle FSM transitions to `degraded` (or `reconnecting` if
 *     a policy is set). Observe via `bridges.mcp.client(id).state`
 *     or the bus envelope `mcp:<scopeId>:state`.
 *   - Tool name collision across servers WITHIN the same default
 *     prefix shape is impossible by construction (the serverId
 *     prefix disambiguates).
 *
 * @see ./content-mapper.ts for the CallToolResult → ContentBlock[] mapping
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md
 */

import type { SessionExtension, SessionInstaller } from "@agentick/spec-next";
import type { ContentBlock, ToolDeclaration, ToolHandler } from "@agentick/spec-next";
import { jsonSchema, toRegistration } from "@agentick/spec-next";

// Side-effect import — pulls in the `SessionHarnessProtocol.elicitation`
// module augmentation. The installer exposes elicit directly today
// (no `getSession` walk needed), but the augmentation keeps the
// typed lookup story honest for adopters who reach through
// `session.elicitation` after the fact.
import "@agentick/elicitation-next";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { McpClientHarness } from "../client/harness.js";
import type { McpAuth } from "../client/auth.js";
import { NoneAuth } from "../client/auth.js";
import type { McpToolDescriptor, ReconnectPolicy } from "../client/types.js";
import type { EraCodec } from "../client/era-codec.js";

import { mcpContentToBlocks } from "./content-mapper.js";
import { mcpTaskEffect } from "./task-bridge.js";

// ============================================================================
// Options
// ============================================================================

export interface McpServerConfig {
  /**
   * Unique server id. Used as the scope of the underlying harness,
   * the prefix for tool names registered into the session
   * ToolExecutor (`<serverId>__<toolName>`), and the lookup key on
   * `bridges.mcp.client(...)`.
   */
  readonly serverId: string;

  /**
   * Pre-built transport (stdio / streamable-http / in-memory).
   *
   * Per-session harness construction means a single transport
   * instance can only serve one session — if the adopter passes a
   * `transport` literal here, it's effectively shared across
   * sessions and will break under multi-session use. For
   * single-session use it's fine. For multi-session use, supply a
   * `transport` FACTORY pattern (a future feature; see ADR-23).
   */
  readonly transport: Transport;

  /** Auth strategy. Defaults to {@link NoneAuth} (stdio default). */
  readonly auth?: McpAuth;

  /** Era codec override; defaults to whatever `selectCodec` picks at handshake. */
  readonly codec?: EraCodec;

  /** Reconnect policy. Omitted = reconnect disabled. */
  readonly reconnect?: ReconnectPolicy;

  /**
   * Override the default `<serverId>__` prefix for registered tool
   * names. Adopters set this to `""` to keep tool names verbatim (at
   * the risk of cross-server collisions).
   */
  readonly toolPrefix?: string;

  /**
   * Client capability declaration sent in `initialize`. Defaults to
   * `{ elicitation: { form: {}, url: {} } }` — both substrate
   * elicit modes advertised. Roots / sampling capabilities land as
   * their bridges ship.
   */
  readonly capabilities?: Readonly<Record<string, unknown>>;

  /**
   * Display name surfaced in the `initialize` handshake. Defaults to
   * `serverId`.
   */
  readonly clientName?: string;

  /**
   * Client version surfaced in the `initialize` handshake. Defaults
   * to `1.0.0`.
   */
  readonly clientVersion?: string;

  /**
   * Default TTL (ms) used when calling this server's `taskSupport:
   * "required"` tools via the task-augmented wire (`tools/call` with
   * `task: { ttl }`). The server may clamp or override. Omit to leave
   * the field off the wire — server's own default applies.
   *
   * Per-tool override is not exposed in Phase B; if a future tool
   * needs a different ttl, add the field on the tool annotation and
   * have `taskSupport` carry the override at registration time.
   */
  readonly defaultTaskTtl?: number;
}

export interface WithMCPOptions {
  readonly servers: readonly McpServerConfig[];
}

// ============================================================================
// Bridge surface
// ============================================================================

export interface McpClientHandle {
  readonly serverId: string;
  readonly harness: McpClientHarness;
}

export interface McpHookBridgeImpl {
  readonly client: (serverId: string) => McpClientHandle | undefined;
  readonly clients: ReadonlyArray<McpClientHandle>;
}

// ============================================================================
// Extension factory
// ============================================================================

const EXTENSION_NAME = "@agentick/mcp-next";

/**
 * Stable `handlerRef` for one MCP tool, scoped to its owning session.
 * Format: `mcp:<sessionId>:<serverId>:<toolName>`. Per-session
 * handlerRefs keep registrations unique on the shared HandlerResolver
 * so two sessions running the same server don't overwrite each
 * other's handlers.
 */
function mcpHandlerRef(sessionId: string, serverId: string, toolName: string): string {
  return `mcp:${sessionId}:${serverId}:${toolName}`;
}

/**
 * Build the `ToolDeclaration` for one MCP-discovered tool. MCP's raw
 * JSON Schema is wrapped via `jsonSchema()` so it round-trips through
 * `StandardSchemaV1`; the executor's `toJsonSchema()` unwraps it at
 * the wire edge.
 *
 * `exposure: ["model", "dispatch"]` — MCP tools are reachable from
 * both doors.
 */
function mcpDeclaration(
  sessionId: string,
  serverId: string,
  tool: McpToolDescriptor,
  localName: string,
): ToolDeclaration {
  const inputSchema = jsonSchema(tool.inputSchema);
  const outputSchema = tool.outputSchema !== undefined ? jsonSchema(tool.outputSchema) : undefined;
  // Bridge MCP's `tool.execution.taskSupport` vocabulary to our
  // framework-local `annotations.taskSupport` convention so the
  // executor's Pattern A/B branching sees a uniform shape regardless
  // of tool origin. MCP enum: optional|required|forbidden. Local
  // enum: supported|required|unsupported (matches earlier framework
  // shape predating the SDK revision).
  const mappedTaskSupport = mapMcpTaskSupport(tool.execution?.taskSupport);
  const annotations: Readonly<Record<string, unknown>> | undefined =
    mappedTaskSupport !== undefined
      ? { ...(tool.annotations ?? {}), taskSupport: mappedTaskSupport }
      : tool.annotations;
  return {
    id: localName,
    name: localName,
    description: tool.description ?? `MCP tool ${serverId}/${tool.name}`,
    inputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    exposure: ["model", "dispatch"],
    handlerRef: mcpHandlerRef(sessionId, serverId, tool.name),
    ...(annotations !== undefined
      ? { annotations: annotations as ToolDeclaration["annotations"] }
      : {}),
  };
}

/**
 * Translate MCP's `execution.taskSupport` enum to our local
 * `annotations.taskSupport` convention. Mapping:
 *
 *   MCP "required"  → local "required"   (server WILL create a task)
 *   MCP "optional"  → local "supported"  (caller chooses per-call)
 *   MCP "forbidden" → local "unsupported"
 *   undefined       → undefined          (tool stays inline)
 */
function mapMcpTaskSupport(
  v: "optional" | "required" | "forbidden" | undefined,
): "required" | "supported" | "unsupported" | undefined {
  switch (v) {
    case "required":
      return "required";
    case "optional":
      return "supported";
    case "forbidden":
      return "unsupported";
    default:
      return undefined;
  }
}

/**
 * Construct one per-session `McpClientHarness` for a server config.
 * The harness's elicit address is fixed at construction to the
 * session's elicit harness — no slot, no resolver callback, no race.
 */
async function mkClient(
  installer: SessionInstaller,
  config: McpServerConfig,
): Promise<McpClientHarness> {
  const harness = new McpClientHarness(
    `${installer.sessionId}:mcp:${config.serverId}`,
    installer.substrate.journal,
    installer.substrate.bus,
    installer.substrate.inbox,
    {
      serverId: config.serverId,
      transport: config.transport,
      auth: config.auth ?? new NoneAuth(),
      elicitAddress: installer.elicitation.address,
      ...(config.codec !== undefined ? { codec: config.codec } : {}),
      ...(config.reconnect !== undefined ? { reconnect: config.reconnect } : {}),
      ...(config.capabilities !== undefined ? { capabilities: config.capabilities } : {}),
      clientInfo: {
        name: config.clientName ?? config.serverId,
        version: config.clientVersion ?? "1.0.0",
      },
    },
  );
  await harness.ready;
  return harness;
}

/**
 * Discover one server's tools and register them with the installer.
 * Each tool gets:
 *   1. A dispatch handler in the shared HandlerResolver, keyed by
 *      a per-session `handlerRef` so cross-session registrations
 *      don't collide.
 *   2. A `ToolRegistration` bound to `{ scope: "extension",
 *      level: "session" }`. Lands in the session's ToolExecutor
 *      initialTools by way of `installer.registerExtensionTool`.
 */
async function discoverAndRegisterTools(
  installer: SessionInstaller,
  config: McpServerConfig,
  harness: McpClientHarness,
): Promise<void> {
  const tools = await harness.listTools();
  const prefix = config.toolPrefix ?? `${config.serverId}__`;
  for (const tool of tools) {
    const localName = `${prefix}${tool.name}`;
    const handlerRef = mcpHandlerRef(installer.sessionId, config.serverId, tool.name);
    // Detect REMOTE task support from MCP's canonical
    // `execution.taskSupport` (per SDK 1.29.0 ToolSchema), translated
    // via {@link mapMcpTaskSupport} to our framework vocabulary.
    // The three branches mirror the three MCP enum values:
    //
    //   "required" (= local "required")  — every call goes through the
    //     task wire. Handler always submits via `ctx.tasks.submit`;
    //     the executor's Pattern A/B branching governs whether the
    //     model sees a `task_ref` or the eventual blocks.
    //   "optional" (= local "supported", #174) — server CAN run as a
    //     task; client picks per call. Handler reads the resolved
    //     dispatch task mode from `ctx.task`:
    //       - `"ref"`              → use task wire + return TaskHandle.
    //       - `"auto"` / `"inline"` → call inline + return blocks.
    //     Default behavior is inline — matches the framework-wide
    //     decision that `supported` tools behave like every other
    //     tool unless the adopter explicitly opts in.
    //   "forbidden" / undefined (= local "unsupported" / undefined) —
    //     handler always calls inline; the task wire is never
    //     exercised. Pre-flight rejects `task: "ref"` for these.
    const localTaskSupport = mapMcpTaskSupport(tool.execution?.taskSupport);
    const handler: ToolHandler =
      localTaskSupport === "required"
        ? (input, { ctx }) =>
            ctx.tasks!.submit<readonly ContentBlock[]>((workCtx) =>
              mcpTaskEffect(
                harness,
                {
                  name: tool.name,
                  args: input as Readonly<Record<string, unknown>>,
                  taskOptions:
                    config.defaultTaskTtl !== undefined ? { ttl: config.defaultTaskTtl } : {},
                },
                workCtx,
              ),
            )
        : localTaskSupport === "supported"
          ? makeSupportedHandler(harness, tool, config)
          : async (input): Promise<readonly ContentBlock[]> => {
              const result = await harness.callTool(
                tool.name,
                input as Readonly<Record<string, unknown>>,
              );
              return mcpContentToBlocks(result.content);
            };
    installer.registerToolHandler(handlerRef, handler);
    installer.registerExtensionTool(
      toRegistration(mcpDeclaration(installer.sessionId, config.serverId, tool, localName), {
        scope: "extension",
        extensionName: EXTENSION_NAME,
        level: "session",
      }),
    );
  }
}

/**
 * Per-call-opt-in handler for an MCP `taskSupport: "optional"` /
 * local `"supported"` tool (#174). The dispatch's resolved task mode
 * (`ctx.task`) decides whether to route through the MCP task wire or
 * just call the tool inline. Default `"auto"` keeps inline behavior.
 *
 * Returns `ToolHandler` typed via assignment so the function's
 * two-branch return (TaskHandle vs Promise<blocks>) lands inside the
 * `ToolHandlerResult` union without contextual-typing fights.
 */
function makeSupportedHandler(
  harness: McpClientHarness,
  tool: { readonly name: string },
  config: McpServerConfig,
): ToolHandler {
  const handler: ToolHandler = (input, { ctx }) => {
    if (ctx.task === "ref") {
      return ctx.tasks!.submit<readonly ContentBlock[]>((workCtx) =>
        mcpTaskEffect(
          harness,
          {
            name: tool.name,
            args: input as Readonly<Record<string, unknown>>,
            taskOptions: config.defaultTaskTtl !== undefined ? { ttl: config.defaultTaskTtl } : {},
          },
          workCtx,
        ),
      );
    }
    const inline: Promise<readonly ContentBlock[]> = harness
      .callTool(tool.name, input as Readonly<Record<string, unknown>>)
      .then((result) => mcpContentToBlocks(result.content));
    return inline;
  };
  return handler;
}

/**
 * `withMCP({ servers })` — per-session SessionExtension. See file
 * header for the lifecycle + multi-tenant rationale.
 */
export function withMCP(options: WithMCPOptions): SessionExtension {
  return {
    name: EXTENSION_NAME,
    target: "session",
    async install(installer: SessionInstaller): Promise<void> {
      const clientsById = new Map<string, McpClientHandle>();
      const handles: McpClientHandle[] = [];

      for (const config of options.servers) {
        const harness = await mkClient(installer, config);
        const handle: McpClientHandle = { serverId: config.serverId, harness };
        clientsById.set(config.serverId, handle);
        handles.push(handle);
        installer.onClose(() => harness.close());

        // Connect + discover. A connect failure records the server as
        // degraded but doesn't block other servers (the lifecycle
        // FSM transitions to `degraded` / `reconnecting`; observe
        // via `bridges.mcp.client(id).state` or the bus envelope
        // `mcp:<scopeId>:state`).
        try {
          await harness.connect();
        } catch {
          continue;
        }
        await discoverAndRegisterTools(installer, config, harness);
      }

      const bridge: McpHookBridgeImpl = {
        client: (serverId) => clientsById.get(serverId),
        clients: handles,
      };
      installer.registerNamespace("mcp", bridge);
    },
  };
}
