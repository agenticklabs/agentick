/**
 * `McpServerHarness` — Shape 1 harness exposing Agentick as MCP server.
 *
 * Symmetric inbound counterpart to `McpClientHarness` (in
 * `@agentick/mcp-next/client`). Same wire vocabulary, opposite
 * direction. Hosted at GATEWAY scope; one instance per `McpServerConfig`
 * in `createGateway({ mcpServers })`.
 *
 * **Skeleton commit (#171b).** This file lands the construction +
 * lifecycle shape: substrate wiring, ready promise, close hook,
 * connection tracking placeholders. Transport mounting, protocol
 * handling, projection, and security pipeline are scoped to #171c
 * onward — each is added as a separate slice without altering this
 * shape.
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md
 * @see packages-next/spec/src/protocol/mcp-server-harness.ts
 */

import { Effect } from "effect";
import { BaseHarness, ulid, type Unsubscribe } from "@agentick/runtime-next";
import type {
  EventBus,
  McpServerConnectionInfo,
  McpServerHarnessProtocol,
  McpRequestContext,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  ToolDeclaration,
} from "@agentick/spec-next";
import { createNotifier, type Notifier } from "@agentick/pubsub-next";
import { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { type McpServerOptions, validateOptions } from "./config.js";
import { buildCapabilities } from "./protocol/lifecycle.js";
import { installToolsHandlers, type ToolHandlerResolver } from "./projection/tools.js";
import { resolveSecurity, type ResolvedSecurity } from "./security/index.js";
import { evaluateConnectionGuard, isMcpSecurityError } from "./security/pipeline.js";
import type { McpConnectionInfo } from "./security/stages.js";
import type { ServerTransport } from "./transports/types.js";

const SURFACE = "mcpServer" as const;
type McpServerSurface = typeof SURFACE;

/**
 * @deprecated Use {@link McpServerOptions} directly. Kept as an alias
 * for backward-compat across the in-flight #171 work.
 *
 * TODO(error-infra / cleanup): remove this alias once any in-tree
 * callers migrate.
 */
export type McpServerHarnessOptions = McpServerOptions;

export class McpServerHarness
  extends BaseHarness<McpServerSurface>
  implements McpServerHarnessProtocol
{
  /** Validated options. */
  private readonly options: McpServerOptions;

  /** Listeners. Mounted at start(); closed at close(). */
  private readonly transports: readonly ServerTransport[];

  /** Per-connection state — SDK Server + transport ref. */
  private readonly connectionState = new Map<
    string,
    { readonly sdkServer: SdkServer; readonly transport: Transport }
  >();

  /** Open connections, keyed by connectionId. */
  private readonly openConnections = new Map<string, McpServerConnectionInfo>();

  /** Fan-out notifier for connection-state subscribers. */
  private readonly connectionNotifier: Notifier = createNotifier();

  /**
   * Snapshot cache for `connections()`. Invalidated on every open /
   * close. Mirrors the pattern used by sibling harnesses
   * (PromptsHarness.listCache, SkillsHarness.listCache).
   */
  private connectionsCache: readonly McpServerConnectionInfo[] | null = null;

  /** Resolved security stack (transport-aware defaults + adopter config). */
  private readonly security: ResolvedSecurity;

  /** Tools registry + handler resolver (canonical view; per-conn projection applies on top). */
  private readonly toolsRegistry: readonly ToolDeclaration[];
  private readonly resolveHandler: ToolHandlerResolver;
  private readonly hasToolsWired: boolean;

  /** Server identity for the MCP `initialize` response. */
  private readonly serverInfo: { name: string; version: string };

  /** True once `close()` has been called. */
  private closed = false;
  /** True once `start()` has been called. */
  private started = false;

  get id(): string {
    return this.scopeId;
  }

  get name(): string {
    return this.options.name;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: McpServerOptions,
  ) {
    super(SURFACE, scopeId, journal, bus, inbox);
    // Validate eagerly — surface bad options at construction, not at
    // first connection. Throws `McpServerConfigInvalid`.
    this.options = validateOptions(options);
    this.transports = this.options.transports;
    this.toolsRegistry = this.options.tools?.registry ?? [];
    this.resolveHandler = this.options.tools?.resolveHandler ?? (() => null);
    this.hasToolsWired = this.options.tools !== undefined;
    this.serverInfo = this.options.serverInfo ?? {
      name: this.options.name,
      version: "0.0.0",
    };
    this.security = resolveSecurity(
      this.options.auth,
      this.options.transports.map((t) => t.kind),
    );
  }

  // ─────────── Read-side surface ───────────

  connections(): readonly McpServerConnectionInfo[] {
    if (this.connectionsCache !== null) return this.connectionsCache;
    const out = Array.from(this.openConnections.values());
    out.sort((a, b) =>
      a.connectedAt < b.connectedAt ? -1 : a.connectedAt > b.connectedAt ? 1 : 0,
    );
    this.connectionsCache = out;
    return out;
  }

  onConnectionChange(listener: () => void): Unsubscribe {
    return this.connectionNotifier.subscribe(listener);
  }

  // ─────────── Direct projection (in-process clients) ───────────

  asClient(): unknown {
    // Implemented in #171g (the `mcp://gateway/<name>` URL form work).
    // Returning a stub here keeps the protocol surface satisfiable;
    // calling it before #171g lands throws the same error path callers
    // will hit if asClient is invoked on a closed server.
    throw new Error(
      "McpServerHarness.asClient() is not yet implemented — lands with #171g (direct projection URL form)",
    );
  }

  // ─────────── Lifecycle ───────────

  /**
   * Mount the configured transports + start accepting connections.
   * Idempotent — calling `start()` after the first call is a no-op.
   * Must be awaited before the server can serve traffic; `close()`
   * works correctly even if `start()` was never called.
   */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    for (const transport of this.transports) {
      await transport.listen(async (sdkTransport, info) => {
        await this.acceptConnection(sdkTransport, info);
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // 1. Stop accepting new connections.
    for (const transport of this.transports) {
      try {
        await transport.close();
      } catch {
        // Best-effort: a failing close shouldn't block the rest of teardown.
      }
    }

    // 2. Drain in-flight connections.
    for (const [, state] of this.connectionState) {
      try {
        await state.sdkServer.close();
      } catch {
        /* best-effort */
      }
    }
    this.connectionState.clear();
    this.openConnections.clear();
    this.connectionsCache = null;
    this.connectionNotifier.notify();
    await super.close();
  }

  /**
   * Per-connection accept logic. Invoked by transports through the
   * `AcceptHandler` callback. Runs the connection guard, builds the
   * SDK Server, installs projection handlers, connects the wire, and
   * registers the connection for observability.
   */
  private async acceptConnection(transport: Transport, info: McpConnectionInfo): Promise<void> {
    if (this.closed) {
      // Race: connection arrived while closing. Tear down the
      // transport without registering.
      try {
        await transport.close();
      } catch {
        /* swallow */
      }
      return;
    }

    // 1. ConnectionGuard. Throws McpServerConnectionRejected on reject.
    try {
      await evaluateConnectionGuard(this.security, info);
    } catch (err) {
      try {
        await transport.close();
      } catch {
        /* swallow */
      }
      if (!isMcpSecurityError(err)) throw err;
      return;
    }

    // 2. Construct SDK Server with negotiated capabilities.
    const capabilities = buildCapabilities(
      {
        tools: this.hasToolsWired && this.toolsRegistry.length > 0,
        prompts: false, // wired in #171d
        resources: false, // wired with #123
        elicitation: false, // wired in #171d
        sampling: false, // wired in #171d
        tasks: false, // wired in #171d
      },
      this.options.capabilities,
    );
    const sdkServer = new SdkServer(this.serverInfo, { capabilities });

    // 3. Track + register the connection.
    const connectionId = `conn:${ulid()}`;
    const connectedAt = Date.now();
    const connectionRecord: McpServerConnectionInfo = {
      connectionId,
      transportKind: info.transportKind,
      connectedAt,
      user: null,
      clientInfo: null,
    };
    this.connectionState.set(connectionId, { sdkServer, transport });
    this._registerConnection(connectionRecord);

    // 4. Install request-handler projections.
    const buildRequestContext = (): McpRequestContext => ({
      serverId: this.scopeId,
      connectionId,
      transportKind: info.transportKind,
      connectedAt,
      user: null,
      clientInfo: null,
      clientCapabilities: null,
      signal: new AbortController().signal,
      metadata: {
        ...(info.headers ? { headers: info.headers } : {}),
        ...(info.origin !== undefined ? { origin: info.origin } : {}),
        ...(info.remoteAddress !== undefined ? { remoteAddress: info.remoteAddress } : {}),
      },
    });

    if (this.hasToolsWired && this.toolsRegistry.length > 0) {
      const projection = this.options.tools;
      installToolsHandlers(sdkServer, {
        registry: this.toolsRegistry,
        resolveHandler: this.resolveHandler,
        ...(projection?.filter || projection?.transforms
          ? {
              projection: {
                ...(projection.filter ? { filter: projection.filter } : {}),
                ...(projection.transforms ? { transforms: projection.transforms } : {}),
              },
            }
          : {}),
        security: this.security,
        buildContext: buildRequestContext,
      });
    }

    // 5. Wire the transport's close path to harness cleanup. The SDK
    //    invokes `onclose` when the underlying transport closes; we
    //    remove the connection from our tracking.
    transport.onclose = () => {
      this.connectionState.delete(connectionId);
      this._removeConnection(connectionId);
    };

    // 6. Connect SDK Server to the transport — starts processing.
    await sdkServer.connect(transport);
  }

  // ─────────── Internal — used by transport + projection layers (#171c+) ───────────

  /**
   * Register an open connection. Called by the transport accept path.
   * Not part of the public protocol; exposed at module-internal scope
   * for projection.ts + transports/* to use during #171c work.
   */
  /** @internal */
  _registerConnection(info: McpServerConnectionInfo): void {
    if (this.closed) {
      throw {
        _tag: "McpServerClosed" as const,
        serverId: this.scopeId,
      };
    }
    this.openConnections.set(info.connectionId, info);
    this.connectionsCache = null;
    this.connectionNotifier.notify();
  }

  /**
   * Remove a closed connection. Idempotent — silently returns if the
   * connection was already removed (e.g., concurrent close paths).
   */
  /** @internal */
  _removeConnection(connectionId: string): void {
    if (!this.openConnections.has(connectionId)) return;
    this.openConnections.delete(connectionId);
    this.connectionsCache = null;
    this.connectionNotifier.notify();
  }

  /** @internal */
  _options(): McpServerOptions {
    return this.options;
  }

  // ─────────── Inbox dispatch ───────────

  /**
   * Inbox handler. The skeleton accepts no message types yet — message-
   * driven mutation of the server (force-disconnect, push notifications
   * to a specific connection, runtime config reload) lands with #171c+.
   * Unknown messages return `MessageRouterError::UnknownType`.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError" as const,
      cause: new Error(
        `mcpServer harness received unknown message type: ${msg.type} (no message handlers wired yet — lands with #171c+)`,
      ),
    });
  }
}
