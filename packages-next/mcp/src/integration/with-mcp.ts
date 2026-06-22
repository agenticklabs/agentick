/**
 * `withMCP({ servers })` — `AppExtension` that wires N MCP server
 * connections into the app + auto-registers each server's discovered
 * tools into every session the app creates.
 *
 * Lifecycle:
 *   1. App install runs `withMCP`'s `install(installer)`.
 *   2. For each server config, the extension constructs an
 *      `McpClientHarness` on the shared substrate, connects, lists
 *      tools, and:
 *        a. Registers a handler closure on the shared `HandlerResolver`
 *           via `installer.registerToolHandler(handlerRef, handler)`.
 *           The closure proxies to `harness.callTool(...)` and maps
 *           the result through {@link mcpContentToBlocks}.
 *        b. Records the tool's declaration + handlerRef via
 *           `installer.registerExtensionTool(...)`. AppHarness merges
 *           these into every session's `ToolExecutor.initialTools`.
 *   3. Exposes the per-server clients on the `bridges.mcp` slot via
 *      `installer.registerNamespace("mcp", { client, clients })` so
 *      in-tree JSX (and future bridges) can reach them.
 *   4. `onClose` cascades — each harness's `close()` runs in
 *      registration order.
 *
 * Tool naming: each tool's local name is `<serverId>__<toolName>` by
 * default — namespaces tools to their server and avoids cross-server
 * collisions (Linear + Notion both expose `create_issue` without
 * either winning the registry). Adopters can override per-server via
 * `toolPrefix`.
 *
 * Failure modes:
 *   - A server failing to connect is recorded but doesn't abort the
 *     other servers — the rest connect and the failed one transitions
 *     to `degraded` (or `reconnecting` if a policy is set).
 *   - A tool name collision across servers WITHIN the same default
 *     prefix shape is impossible by construction (the serverId
 *     prefix disambiguates).
 *
 * @see ./content-mapper.ts for the CallToolResult → ContentBlock[] mapping
 */

import type { AppExtension, AppInstaller } from "@agentick/spec-next";
import type { ToolDeclaration, ToolHandler, ToolRegistration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { McpClientHarness } from "../client/harness.js";
import type { McpAuth } from "../client/auth.js";
import { NoneAuth } from "../client/auth.js";
import type { ReconnectPolicy } from "../client/types.js";
import type { EraCodec } from "../client/era-codec.js";

import { mcpContentToBlocks } from "./content-mapper.js";

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

  /** Pre-built transport (stdio / streamable-http / in-memory). */
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
   * the minimal substrate set (`elicitation.form`); the
   * `ElicitationBridge` (#4) augments it with the URL mode and
   * inbound elicit handling.
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

/**
 * `withMCP({ servers })` — app-level extension. See file-header for
 * lifecycle details. Returns a single `AppExtension`; tool
 * registration into per-session ToolExecutors happens via
 * `installer.registerExtensionTool` so no companion SessionExtension
 * is needed.
 */
export function withMCP(options: WithMCPOptions): AppExtension {
  return {
    name: "@agentick/mcp-next",
    target: "app",
    async install(installer: AppInstaller): Promise<void> {
      const handles: McpClientHandle[] = [];

      for (const config of options.servers) {
        const harness = new McpClientHarness(
          `${installer.hostId}:mcp:${config.serverId}`,
          installer.substrate.journal,
          installer.substrate.bus,
          installer.substrate.inbox,
          {
            serverId: config.serverId,
            transport: config.transport,
            auth: config.auth ?? new NoneAuth(),
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

        // Connect + discover tools. A failure here records the server
        // as degraded but doesn't block other servers — adopter sees
        // the state via bridges.mcp.client(id).state or the bus
        // envelope `mcp:<scopeId>:state`.
        try {
          await harness.connect();
        } catch {
          // McpLifecycle has already transitioned to `degraded` /
          // `reconnecting`. Skip discovery; tools register only after
          // a successful connect. Future-work: re-run discovery on
          // re-ready transition.
          handles.push({ serverId: config.serverId, harness });
          installer.onClose(() => harness.close());
          continue;
        }

        const tools = await harness.listTools();
        const prefix = config.toolPrefix ?? `${config.serverId}__`;

        for (const tool of tools) {
          const localName = `${prefix}${tool.name}`;
          const handlerRef = `mcp:${config.serverId}:${tool.name}`;

          const handler: ToolHandler = async (input) => {
            const result = await harness.callTool(
              tool.name,
              input as Readonly<Record<string, unknown>>,
            );
            return mcpContentToBlocks(result.content);
          };

          installer.registerToolHandler(handlerRef, handler);

          // Wrap MCP's raw JSON Schema as a Standard-Schema carrier
          // so it round-trips through `ToolDeclaration` cleanly.
          // Wire-edge projection (`toJsonSchema()` in the executor)
          // unwraps it back to the same JSON Schema for the model.
          const inputSchema = jsonSchema(tool.inputSchema);
          const outputSchema =
            tool.outputSchema !== undefined ? jsonSchema(tool.outputSchema) : undefined;

          const declaration: ToolDeclaration = {
            id: localName,
            name: localName,
            description: tool.description ?? `MCP tool ${config.serverId}/${tool.name}`,
            inputSchema,
            ...(outputSchema !== undefined ? { outputSchema } : {}),
            // Both doors: the model can call MCP tools via tool_use
            // (model door) AND the host can call them programmatically
            // via session.dispatch() (host door). MCP servers don't
            // care which door routed the call — the dispatch-origin
            // policy is local-side framework concern, not MCP
            // semantics. Adopters who want to restrict can override
            // via metadata + middleware in a follow-up.
            exposure: ["model", "dispatch"],
            handlerRef,
            ...(tool.annotations !== undefined
              ? { annotations: tool.annotations as ToolDeclaration["annotations"] }
              : {}),
          };
          // withMCP is an app-level extension — tools register at the
          // extension binding slot, level=app. Slice 8 finalizes the
          // shape once installer.hostScope context is threaded so
          // session/gateway-level installs declare their own level
          // symmetrically.
          const registration: ToolRegistration = {
            declaration,
            handlerRef,
            binding: { scope: "extension", extensionName: "@agentick/mcp-next", level: "app" },
          };
          installer.registerExtensionTool(registration);
        }

        handles.push({ serverId: config.serverId, harness });
        installer.onClose(() => harness.close());
      }

      const bridge: McpHookBridgeImpl = {
        client(serverId: string): McpClientHandle | undefined {
          return handles.find((h) => h.serverId === serverId);
        },
        clients: handles,
      };
      installer.registerNamespace("mcp", bridge);
    },
  };
}
