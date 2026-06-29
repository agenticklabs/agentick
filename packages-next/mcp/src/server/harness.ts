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
import { BaseHarness, type Unsubscribe } from "@agentick/runtime-next";
import type {
  EventBus,
  McpServerConfig,
  McpServerConnectionInfo,
  McpServerHarnessProtocol,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
} from "@agentick/spec-next";
import { createNotifier, type Notifier } from "@agentick/pubsub-next";

import { validateConfig } from "./config.js";

const SURFACE = "mcpServer" as const;
type McpServerSurface = typeof SURFACE;

/**
 * Construction options. The config arg is the resolved
 * {@link McpServerConfig}; substrate args (journal/bus/inbox) come
 * from the gateway substrate the harness is mounted under.
 */
export interface McpServerHarnessOptions {
  readonly config: McpServerConfig;
}

export class McpServerHarness
  extends BaseHarness<McpServerSurface>
  implements McpServerHarnessProtocol
{
  /** Resolved config — validated at construction. */
  private readonly config: McpServerConfig;

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

  /** True once `close()` has been called. */
  private closed = false;

  get id(): string {
    return this.scopeId;
  }

  get name(): string {
    return this.config.name;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: McpServerHarnessOptions,
  ) {
    super(SURFACE, scopeId, journal, bus, inbox);
    // Validate eagerly — surface bad configs at construction, not at
    // first connection. Throws `McpServerConfigInvalid`.
    this.config = validateConfig(options.config);
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Connection teardown lands with the transport work (#171c+); for
    // now closing just empties the registry. Each connection's own
    // transport close path will hook in here via
    // `removeConnection(connectionId)` once transports exist.
    this.openConnections.clear();
    this.connectionsCache = null;
    this.connectionNotifier.notify();
    await super.close();
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
  _config(): McpServerConfig {
    return this.config;
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
