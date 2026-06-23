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
import type {
  ElicitationHarnessProtocol,
  SessionHarnessProtocol,
  ToolDeclaration,
  ToolHandler,
} from "@agentick/spec-next";
import { jsonSchema, toRegistration } from "@agentick/spec-next";

// Side-effect import — pulls in the `SessionHarnessProtocol.elicitation`
// module-augmentation slot so `session.elicitation` types as
// `ElicitationHarnessProtocol` (with its `address` field) rather than
// `unknown` when looked up via `installer.app.getSession(id)`.
import "@agentick/elicitation-next";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { McpClientHarness } from "../client/harness.js";
import type { McpAuth } from "../client/auth.js";
import { NoneAuth } from "../client/auth.js";
import type { McpToolDescriptor, ReconnectPolicy } from "../client/types.js";
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
 * Stable extension name — used as the `extensionName` field on every
 * tool's binding. Sessions that look up bindings by extension reach
 * MCP-contributed tools via this constant.
 */
const EXTENSION_NAME = "@agentick/mcp-next";

/**
 * Stable `handlerRef` for one MCP tool. Format: `mcp:<serverId>:<toolName>`.
 * Used by the HandlerResolver to route dispatches back to the right
 * `McpClientHarness.callTool`.
 */
function mcpHandlerRef(serverId: string, toolName: string): string {
  return `mcp:${serverId}:${toolName}`;
}

/**
 * Build the `ToolDeclaration` for one MCP-discovered tool. MCP's raw
 * JSON Schema is wrapped via `jsonSchema()` so it round-trips through
 * `StandardSchemaV1`; the executor's `toJsonSchema()` unwraps it at
 * the wire edge.
 *
 * `exposure: ["model", "dispatch"]` — MCP tools are reachable from
 * both doors. The model can invoke via `tool_use`; the host can
 * invoke programmatically via `session.dispatch(name, input)`. MCP
 * servers don't care which door routed the call.
 */
function mcpDeclaration(
  serverId: string,
  tool: McpToolDescriptor,
  localName: string,
): ToolDeclaration {
  const inputSchema = jsonSchema(tool.inputSchema);
  const outputSchema = tool.outputSchema !== undefined ? jsonSchema(tool.outputSchema) : undefined;
  return {
    id: localName,
    name: localName,
    description: tool.description ?? `MCP tool ${serverId}/${tool.name}`,
    inputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    exposure: ["model", "dispatch"],
    handlerRef: mcpHandlerRef(serverId, tool.name),
    ...(tool.annotations !== undefined
      ? { annotations: tool.annotations as ToolDeclaration["annotations"] }
      : {}),
  };
}

/**
 * Construct one `McpClientHarness` for a server config. Awaits its
 * `.ready` so the caller can invoke methods immediately.
 */
async function mkClient(
  installer: AppInstaller,
  config: McpServerConfig,
): Promise<McpClientHarness> {
  // Closure over installer.app — resolves a session's elicit harness
  // address at the moment the SDK's elicit handler fires. The lookup
  // happens lazily because sessions don't exist yet at app-install
  // time. In-memory: walks the app's session registry. Cluster
  // (#151+): swaps this resolver for a cluster directory lookup.
  const resolveElicitAddress = (sessionId: string): string | undefined => {
    const session = installer.app.getSession?.(sessionId) as
      | (SessionHarnessProtocol<unknown> & {
          readonly elicitation?: ElicitationHarnessProtocol;
        })
      | undefined;
    return session?.elicitation?.address;
  };
  const harness = new McpClientHarness(
    `${installer.hostId}:mcp:${config.serverId}`,
    installer.substrate.journal,
    installer.substrate.bus,
    installer.substrate.inbox,
    {
      serverId: config.serverId,
      transport: config.transport,
      auth: config.auth ?? new NoneAuth(),
      resolveElicitAddress,
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
 *   1. A dispatch handler in the shared HandlerResolver — proxies
 *      to `harness.callTool` and maps MCP content → ContentBlock[].
 *   2. A `ToolRegistration` bound to the extension slot at app level.
 *      The session's per-tick compile picks them up at the extension
 *      binding's precedence rank.
 */
async function discoverAndRegisterTools(
  installer: AppInstaller,
  config: McpServerConfig,
  harness: McpClientHarness,
): Promise<void> {
  const tools = await harness.listTools();
  const prefix = config.toolPrefix ?? `${config.serverId}__`;
  // Capture the installer-host reference so the per-call resolver
  // lookup can reach the live session registry at dispatch time. App
  // extensions install BEFORE sessions exist; the closure resolves
  // sessions lazily.
  for (const tool of tools) {
    const localName = `${prefix}${tool.name}`;
    const handlerRef = mcpHandlerRef(config.serverId, tool.name);
    const handler: ToolHandler = async (input, { ctx }) => {
      // Pass the session id directly. The harness routes inbound
      // elicits via inbox to whichever address its
      // `resolveElicitAddress` returns — cluster-friendly seam.
      const result = await harness.callTool(
        tool.name,
        input as Readonly<Record<string, unknown>>,
        ctx.sessionId !== undefined ? { elicitSessionId: ctx.sessionId } : undefined,
      );
      return mcpContentToBlocks(result.content);
    };
    installer.registerToolHandler(handlerRef, handler);
    installer.registerExtensionTool(
      toRegistration(mcpDeclaration(config.serverId, tool, localName), {
        scope: "extension",
        extensionName: EXTENSION_NAME,
        level: "app",
      }),
    );
  }
}

/**
 * `withMCP({ servers })` — app-level extension. See file-header for
 * lifecycle details. Returns a single `AppExtension`; tool
 * registration into per-session ToolExecutors happens via
 * `installer.registerExtensionTool` so no companion SessionExtension
 * is needed.
 */
export function withMCP(options: WithMCPOptions): AppExtension {
  return {
    name: EXTENSION_NAME,
    target: "app",
    async install(installer: AppInstaller): Promise<void> {
      // `clientsById` is the lookup index — O(1) `bridge.client(id)`.
      // `handles` is the insertion-ordered enumeration for
      // `bridge.clients`. Both point at the same `McpClientHandle`
      // objects — one map, one list, one allocation per client.
      const clientsById = new Map<string, McpClientHandle>();
      const handles: McpClientHandle[] = [];

      for (const config of options.servers) {
        const harness = await mkClient(installer, config);
        const handle: McpClientHandle = { serverId: config.serverId, harness };
        clientsById.set(config.serverId, handle);
        handles.push(handle);
        installer.onClose(() => harness.close());

        // Connect + discover. A connect failure records the server as
        // degraded but doesn't block other servers (the lifecycle FSM
        // has already transitioned to `degraded` / `reconnecting`;
        // adopters observe via `bridges.mcp.client(id).state` or the
        // bus envelope `mcp:<scopeId>:state`). Future-work: re-run
        // discovery on the next `connected` transition.
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
