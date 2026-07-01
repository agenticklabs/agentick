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

import type {
  CredentialsHarnessProtocol,
  SessionExtension,
  SessionInstaller,
  Unsubscribe,
} from "@agentick/spec-next";
import type { ContentBlock, ToolDeclaration, ToolHandler } from "@agentick/spec-next";
import { jsonSchema, toRegistration } from "@agentick/spec-next";
import { readContext, type RuntimeContext } from "@agentick/runtime-next";

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
import {
  isTransportFactory,
  type CredentialField,
  type TransportFactory,
  type TransportFactoryDeps,
} from "./transport-factory.js";
import { omitUndefined } from "@agentick/utils-next";

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
   * Transport for this server. Two shapes (#154):
   *
   *   - `Transport` — pre-built SDK transport instance (stdio,
   *     pre-authenticated HTTP, in-memory). Single-session use is
   *     safe; multi-session use shares the instance across sessions
   *     and breaks under concurrent connections.
   *
   *   - {@link TransportFactory} — `(deps) => Transport`. Constructed
   *     once per session at install time; `deps` carries the session-
   *     bound elicit binding (`installer.elicitation.elicit`) so
   *     OAuth-over-HTTP factories can wire
   *     `DefaultOAuthProvider({ elicit: deps.elicit, ... })` without
   *     adopter boilerplate per session. Each session gets its own
   *     transport, so multi-session deployments are safe.
   *
   * Adopters who don't need OAuth — stay with the pre-built form.
   * OAuth adopters use the factory.
   */
  readonly transport: Transport | TransportFactory;

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

  /**
   * Derive the credentials-store key for one of an MCP server's four
   * OAuth fields (`tokens` / `client` / `verifier` / `discovery`).
   * Default: `mcp:<serverId>:<field>` — a flat single-tenant scheme.
   *
   * Override to namespace credentials by user / tenant / any value
   * readable from the active {@link RuntimeContext} (typed via
   * `RuntimeContextUser` augmentation):
   *
   *     // Adopter app augments first:
   *     declare module "@agentick/runtime-next" {
   *       interface RuntimeContextUser {
   *         readonly tenantId: string;
   *       }
   *     }
   *
   *     // Then in withMCP:
   *     credentialKey: (ctx, { serverId, field }) =>
   *       `mcp:${String(ctx.user?.tenantId ?? "anon")}:${serverId}:${field}`,
   *
   * Strategy pattern — same shape as sliding-window's `keyFn`,
   * bearer's `extract`, etc. The store stays singleton +
   * tenant-ignorant; user-awareness lives at this one composition site.
   *
   * ## Multi-tenant — recommended pattern
   *
   * Per ADR 45 (the runtime context model), the cleanest multi-tenant
   * approach is **structural identity** — encode the principal in the
   * harness's `serverId` itself rather than reading from ambient
   * context. Each principal gets its own `McpClientHarness` instance:
   *
   *     withMCP({
   *       servers: [{
   *         serverId: `linear:user-${principal.userId}`,
   *         transport: ...,
   *       }],
   *     });
   *
   * The default `credentialKey` (`mcp:<serverId>:<field>`) then
   * already namespaces per-principal because `serverId` itself does.
   * No `credentialKey` override needed.
   *
   * ## When `credentialKey` is genuinely useful
   *
   * The override matters when multiple principals SHARE a harness
   * instance and you want their credentials kept separate within the
   * shared store. That's the unusual case (most adopters fan out
   * per-principal harnesses). Document the propagation caveats
   * (`readContext()` returns `EMPTY_CONTEXT` inside Effect fibers
   * unless ctx was bound via `withContext` at the call boundary) and
   * prefer structural identity when feasible.
   *
   * @see docs/proposals/v2/blueprint/45-runtime-context-model.md
   */
  readonly credentialKey?: (
    ctx: RuntimeContext,
    deps: { readonly serverId: string; readonly field: CredentialField },
  ) => string;
}

/**
 * Default key composition when `WithMCPOptions.credentialKey` is unset.
 * Single-tenant flat scheme — `mcp:<serverId>:<field>`. Adopters
 * override the composition; the harness never reaches into the
 * default itself (the resolved string is what gets passed to the
 * provider).
 */
function defaultCredentialKey(serverId: string, field: CredentialField): string {
  return `mcp:${serverId}:${field}`;
}

// ============================================================================
// Bridge surface
// ============================================================================

export interface McpHookBridgeImpl {
  readonly client: (serverId: string) => McpClientHarness | undefined;
  readonly clients: ReadonlyArray<McpClientHarness>;
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
 *
 * `credentials` is the substrate credentials harness if installed
 * (via app-/gateway-level `withCredentials({ store })`); `undefined`
 * means OAuth providers fall back to in-memory. `keyOfField` is the
 * resolved key strategy for this server — defaulted from
 * `defaultCredentialKey` or composed from the adopter's
 * `WithMCPOptions.credentialKey`.
 */
async function mkClient(
  installer: SessionInstaller,
  config: McpServerConfig,
  credentials: CredentialsHarnessProtocol | undefined,
  keyOfField: (field: CredentialField) => string,
): Promise<McpClientHarness> {
  // Build the factory-deps shape once; both the initial build and
  // the `rebuildTransport` closure consume the same object with a
  // different `interactive` flag. `credentials` is conditionally
  // present in the spread — adopters whose factories don't need it
  // can ignore it; OAuth factories destructure it.
  const baseDeps = (interactive: boolean): TransportFactoryDeps => ({
    elicit: (request) => installer.elicitation.elicit(request),
    serverId: config.serverId,
    credentialKey: keyOfField,
    interactive,
    ...(credentials !== undefined ? { credentials } : {}),
  });

  // Resolve the initial transport — optimistic build (interactive=false).
  // Per #154, `config.transport` may be a pre-built `Transport` or a
  // `TransportFactory`. The factory path is the canonical way to wire
  // OAuth-over-HTTP.
  const transport = isTransportFactory(config.transport)
    ? await config.transport(baseDeps(false))
    : config.transport;

  // If the adopter supplied a factory, expose a rebuild closure on
  // the harness so `reauthenticate()` can re-run it with
  // `interactive: true`. Pre-built transports skip this — there's no
  // factory to re-run, and reauthenticate falls back to a
  // disconnect+connect against the original transport.
  const rebuildTransport: ((deps: { interactive: boolean }) => Promise<Transport>) | undefined =
    isTransportFactory(config.transport)
      ? async (deps): Promise<Transport> => {
          const factory = config.transport;
          if (!isTransportFactory(factory)) {
            throw new Error(`unreachable: transport became non-factory mid-session`);
          }
          return factory(baseDeps(deps.interactive));
        }
      : undefined;

  const harness = new McpClientHarness(
    `${installer.sessionId}:mcp:${config.serverId}`,
    installer.substrate.journal,
    installer.substrate.bus,
    installer.substrate.inbox,
    {
      serverId: config.serverId,
      transport,
      auth: config.auth ?? new NoneAuth(),
      elicitAddress: installer.elicitation.address,
      ...omitUndefined({
        codec: config.codec,
        reconnect: config.reconnect,
        capabilities: config.capabilities,
        rebuildTransport,
      }),
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
): Promise<readonly Unsubscribe[]> {
  const tools = await harness.listTools();
  const prefix = config.toolPrefix ?? `${config.serverId}__`;
  const unsubscribes: Unsubscribe[] = [];
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
    unsubscribes.push(installer.registerToolHandler(handlerRef, handler));
    unsubscribes.push(
      installer.registerExtensionTool(
        toRegistration(mcpDeclaration(installer.sessionId, config.serverId, tool, localName), {
          scope: "extension",
          extensionName: EXTENSION_NAME,
          level: "session",
        }),
      ),
    );
  }
  return unsubscribes;
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
      const clientsById = new Map<string, McpClientHarness>();
      const harnesses: McpClientHarness[] = [];

      // Pull the substrate credentials harness if one is installed at
      // app or gateway level via `withCredentials({ store })`. Optional
      // — OAuth providers fall back to in-memory persistence when
      // absent (matches the bootstrap shape for adopters who haven't
      // yet wired credentials).
      const credentials = installer.getNamespace<CredentialsHarnessProtocol>("credentials");

      for (const config of options.servers) {
        // Per-server key resolver. Reads `RuntimeContext` at every
        // call (not once per session) so request-scoped principals
        // (e.g. `ctx.user?.tenantId` after adopter augments
        // `RuntimeContextUser`) compose correctly. Caveat: readContext()
        // returns EMPTY_CONTEXT inside Effect fibers — see ADR 45.
        // Prefer structural identity (per-principal serverId) when
        // feasible; this hook is for cases where harnesses are shared.
        const serverKeyOf = (field: CredentialField): string =>
          options.credentialKey
            ? options.credentialKey(readContext(), { serverId: config.serverId, field })
            : defaultCredentialKey(config.serverId, field);
        const harness = await mkClient(installer, config, credentials, serverKeyOf);
        clientsById.set(config.serverId, harness);
        harnesses.push(harness);
        installer.onClose(() => harness.close());

        // Eager optimistic connect on install + inline tool
        // discovery. Connect failure surfaces on `harness.status`
        // as `error` (visible through `onStatusChange` subscribers);
        // it does NOT throw out of the install loop. Discovery runs
        // only after a successful connect — must complete before
        // the install loop moves on so tool registrations are
        // visible to session.dispatch by the time the install
        // returns. Discovery failures are non-fatal (caught + logged
        // via the substrate bus by the ToolExecutor; the harness's
        // status remains `connected`).
        try {
          await harness.connect();
        } catch {
          continue;
        }
        // Track per-harness tool registration teardowns so the
        // reactive re-discovery path can swap in a fresh set when
        // the MCP server pushes `notifications/tools/list_changed`
        // (#309). Also caches the teardowns for session close.
        let currentUnsubs: readonly Unsubscribe[] = [];
        if (harness.status.kind === "connected") {
          try {
            currentUnsubs = await discoverAndRegisterTools(installer, config, harness);
          } catch {
            // Tool-discovery failures are non-fatal for the
            // connection-status FSM. Adopters watching for "tools
            // registered" subscribe to the ToolExecutor's
            // registration stream, not the harness.
          }
        }

        // Reactive re-discovery — the MCP server MAY emit
        // `notifications/tools/list_changed` when its catalog
        // mutates. On each such signal, tear down our previous
        // registrations and re-run discovery. Serialized via a
        // rolling promise so overlapping notifications don't race
        // (second re-discovery waits for first to finish clearing
        // + re-registering).
        //
        // Prompt / resource notifications fire too but withMCP does
        // not project prompts or resources today — ignored here.
        // Adopters observing at the harness layer via
        // `harness.onListChanged` still see all three.
        let rediscoveryInFlight: Promise<void> = Promise.resolve();
        const unsubListChanged = harness.onListChanged((event) => {
          if (event.kind !== "tools") return;
          rediscoveryInFlight = rediscoveryInFlight.then(async () => {
            for (const u of currentUnsubs) u();
            try {
              currentUnsubs = await discoverAndRegisterTools(installer, config, harness);
            } catch {
              // Discovery failed on the way back — leave torn down
              // rather than a partial re-registration. Next
              // notification triggers another attempt.
              currentUnsubs = [];
            }
          });
        });

        installer.onClose(() => {
          unsubListChanged();
          for (const u of currentUnsubs) u();
        });
      }

      const bridge: McpHookBridgeImpl = {
        client: (serverId) => clientsById.get(serverId),
        clients: harnesses,
      };
      installer.registerNamespace("mcp", bridge);
    },
  };
}
