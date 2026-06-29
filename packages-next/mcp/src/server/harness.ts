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
  Prompts,
} from "@agentick/spec-next";
import { HandlerError, McpServerClosed } from "@agentick/spec-next";
import { createNotifier, type Notifier } from "@agentick/pubsub-next";
import { PromptsHarness } from "@agentick/prompts-next";
import { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  resolveElicitOption,
  resolvePromptsOption,
  resolveToolsOption,
  type McpServerOptions,
  type PromptsFilter,
  type ResolvedToolsOptions,
  validateOptions,
} from "./config.js";
import { buildCapabilities } from "./protocol/lifecycle.js";
import { buildMcpElicit } from "./projection/elicitation.js";
import { installPromptsHandlers } from "./projection/prompts.js";
import { installToolsHandlers } from "./projection/tools.js";
import { resolveSecurity, type ResolvedSecurity } from "./security/index.js";
import { evaluateConnectionGuard, isMcpSecurityError } from "./security/pipeline.js";
import type { McpConnectionInfo } from "./security/stages.js";
import type { ServerTransport } from "./transports/types.js";
import { isFalsey, isNull, omitUndefined } from "@agentick/utils-next";

const SURFACE = "mcpServer" as const;
type McpServerSurface = typeof SURFACE;

export class McpServerHarness
  extends BaseHarness<McpServerSurface>
  implements McpServerHarnessProtocol
{
  /** Validated options. */
  private readonly options: McpServerOptions;

  /** Listeners. Mounted at start(); closed at close(). */
  private readonly transports: readonly ServerTransport[];

  /** Per-connection state — SDK Server + transport ref + cleanup hooks. */
  private readonly connectionState = new Map<
    string,
    {
      readonly sdkServer: SdkServer;
      readonly transport: Transport;
      readonly cleanup: readonly Unsubscribe[];
    }
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

  /**
   * Resolved tools projection — registry + handler resolver + filter +
   * transforms, normalized from any of the {@link McpServerToolsOptions}
   * shapes via {@link resolveToolsOption}. `null` when no tools slot
   * was provided.
   */
  private readonly resolvedTools: ResolvedToolsOptions | null;

  /**
   * Resolved Prompts source — either internally constructed from the
   * declarations on options, or the adopter-supplied instance. `null`
   * when no prompts slot was provided. Lifecycle:
   *
   *   - Internally-constructed: this harness's `close()` closes it.
   *   - Adopter-supplied (the `use` form): adopter owns lifecycle;
   *     `close()` here is a no-op for the source.
   */
  private readonly promptsSource: Prompts | null;
  /** True iff `promptsSource` is internally-owned (so close it on close). */
  private readonly ownsPromptsSource: boolean;
  /** Declarations to register into `promptsSource` during start(). */
  private readonly pendingPromptDeclarations: readonly import("@agentick/spec-next").PromptDeclaration[];
  /** Per-connection prompts visibility predicate (resolved from options). */
  private readonly promptsFilter: PromptsFilter | null;

  /** True when `options.elicit` opted into the elicitation capability. */
  private readonly elicitWired: boolean;

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

  /**
   * The Prompts source this server projects on the wire, or `null` if
   * no prompts slot was wired. Use this to register/update/remove
   * prompts at runtime (independent of how it was originally
   * constructed — declarative array or pre-built instance).
   */
  get prompts(): Prompts | null {
    return this.promptsSource;
  }

  /**
   * Read-only flag indicating whether the server is willing to issue
   * `elicitation/create` requests to connected clients. `true` by
   * default; `false` only when the adopter explicitly opted out via
   * `elicit: false`. Note that even when `true`, `ctx.elicit` is
   * `undefined` for clients that didn't advertise the capability —
   * this flag reports the server's POLICY, not whether any given
   * client supports it.
   */
  get elicitEnabled(): boolean {
    return this.elicitWired;
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
    this.resolvedTools =
      this.options.tools !== undefined ? resolveToolsOption(this.options.tools) : null;

    if (!isFalsey(this.options.prompts)) {
      const resolved = resolvePromptsOption(this.options.prompts);
      this.promptsFilter = resolved.filter;
      if (!isNull(resolved.use)) {
        // Adopter-supplied instance.
        this.promptsSource = resolved.use;
        this.ownsPromptsSource = false;
        this.pendingPromptDeclarations = [];
      } else {
        // Construct internally; substrate shared with this harness so
        // events flow through the same bus / are journaled coherently.
        this.promptsSource = new PromptsHarness(`${scopeId}:prompts`, journal, bus, inbox);
        this.ownsPromptsSource = true;
        this.pendingPromptDeclarations = resolved.declarations;
      }
    } else {
      this.promptsSource = null;
      this.ownsPromptsSource = false;
      this.pendingPromptDeclarations = [];
      this.promptsFilter = null;
    }

    this.elicitWired = resolveElicitOption(this.options.elicit);

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
    if (!isNull(this.connectionsCache)) return this.connectionsCache;
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

    // Internally-owned Prompts: wait for ready + register the initial
    // declarations. Adopter-owned sources are assumed ready already
    // (and registering would be the adopter's responsibility).
    if (!isNull(this.promptsSource) && this.ownsPromptsSource) {
      await this.promptsSource.ready;
      for (const declaration of this.pendingPromptDeclarations) {
        await this.promptsSource.register({ declaration });
      }
    }

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
      for (const fn of state.cleanup) {
        try {
          fn();
        } catch {
          /* best-effort */
        }
      }
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

    // 3. Close the internally-owned Prompts source. Adopter-supplied
    //    sources are NOT closed — the adopter owns their lifecycle.
    if (!isNull(this.promptsSource) && this.ownsPromptsSource) {
      try {
        await this.promptsSource.close();
      } catch {
        /* best-effort */
      }
    }

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
        tools: !isNull(this.resolvedTools) && this.resolvedTools.registry.length > 0,
        prompts: !isNull(this.promptsSource),
        resources: false, // wired with #123
        elicitation: this.elicitWired,
        sampling: false, // wired with SamplingHarness
        tasks: false, // wired in #171d.3
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
    const cleanup: Unsubscribe[] = [];
    this.connectionState.set(connectionId, { sdkServer, transport, cleanup });
    this._registerConnection(connectionRecord);

    // 4. Install request-handler projections.
    const buildRequestContext = (): McpRequestContext => {
      // Pull the client's negotiated capabilities + identity from the
      // SDK Server post-initialize. Undefined before initialize
      // completes (which it always has by the time any request handler
      // runs, since the SDK gates requests behind initialize).
      const sdkClientCaps =
        (sdkServer.getClientCapabilities?.() as Readonly<Record<string, unknown>> | undefined) ??
        null;
      const sdkClientInfo = sdkServer.getClientVersion?.() ?? null;

      // ADR 43 — unified ToolHandlerCtx with `transport: "mcp"` +
      // MCP-specific extras nested under `mcp:`. Tool handlers receive
      // the SAME ctx shape whether dispatched in-process or via MCP.
      const ctx: McpRequestContext = {
        // Universal ToolHandlerCtx fields. The MCP server doesn't have
        // a `toolCallId` until the tool-call handler runs and the
        // tools projection generates one; we synthesize a default here
        // that the tool-projection layer overwrites per-call. Same for
        // `task` — MCP tools default to `"auto"` until per-call wire
        // metadata flips them.
        toolCallId: `mcp:req:${ulid()}`,
        signal: new AbortController().signal,
        setState: () => {
          /* no-op for MCP-server ctx — sessions own this */
        },
        emit: () => {
          /* no-op for MCP-server ctx — sessions own channel emit */
        },
        task: "auto",
        transport: "mcp" as const,
        mcp: {
          serverId: this.scopeId,
          connectionId,
          transportKind: info.transportKind,
          connectedAt,
          user: null,
          clientInfo: sdkClientInfo
            ? { name: sdkClientInfo.name, version: sdkClientInfo.version }
            : null,
          clientCapabilities: sdkClientCaps,
        },
        metadata: omitUndefined({
          ...(info.headers ? { headers: info.headers } : {}),
          origin: info.origin,
          remoteAddress: info.remoteAddress,
        }),
      };

      // Attach `elicit` sugar when wired AND the client advertised
      // the capability. Tool handlers must check for presence — the
      // slot is optional per spec.
      if (this.elicitWired) {
        const elicit = buildMcpElicit({ sdkServer, clientCapabilities: sdkClientCaps });
        if (elicit.canDoForm() || elicit.canDoUrl()) {
          return { ...ctx, elicit };
        }
      }
      return ctx;
    };

    if (!isNull(this.resolvedTools) && this.resolvedTools.registry.length > 0) {
      const tools = this.resolvedTools;
      installToolsHandlers(sdkServer, {
        registry: tools.registry,
        resolveHandler: tools.resolveHandler,
        ...(tools.filter || tools.transforms.length > 0
          ? {
              projection: {
                ...(tools.filter ? { filter: tools.filter } : {}),
                ...(tools.transforms.length > 0 ? { transforms: tools.transforms } : {}),
              },
            }
          : {}),
        security: this.security,
        buildContext: buildRequestContext,
      });
    }

    if (this.promptsSource !== null) {
      const unsubscribe = installPromptsHandlers(sdkServer, {
        source: this.promptsSource,
        ...(this.promptsFilter ? { filter: this.promptsFilter } : {}),
        security: this.security,
        buildContext: buildRequestContext,
      });
      cleanup.push(unsubscribe);
    }

    // 5. Wire the transport's close path to harness cleanup. The SDK
    //    invokes `onclose` when the underlying transport closes; we
    //    remove the connection from our tracking and run per-connection
    //    cleanup (harness subscriptions, etc.).
    transport.onclose = () => {
      const state = this.connectionState.get(connectionId);
      this.connectionState.delete(connectionId);
      this._removeConnection(connectionId);
      if (state) {
        for (const fn of state.cleanup) {
          try {
            fn();
          } catch {
            /* swallow */
          }
        }
      }
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
      throw new McpServerClosed({ serverId: this.scopeId });
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
    return Effect.fail(
      new HandlerError({
        cause: new Error(
          `mcpServer harness received unknown message type: ${msg.type} (no message handlers wired yet — lands with #171c+)`,
        ),
      }),
    );
  }
}
