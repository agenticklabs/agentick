/**
 * `McpClientHarness` — one harness per MCP server connection.
 *
 * Composes four pluggable layers behind a single BaseHarness:
 *
 *   ├ McpTransport    — wire (stdio / streamable-http / in-memory)
 *   ├ McpAuth         — token strategy (None / Bearer / OAuth21 in #5)
 *   ├ McpProtocol     — SDK Client wrapping `initialize` + RPCs
 *   └ McpLifecycle    — state machine + reconnect
 *
 * What the harness owns end-to-end:
 *   - `connect()`     — opens the transport, performs `initialize`,
 *                        selects an era codec, transitions to `ready`
 *   - `callTool(...)` — round-trips an MCP `tools/call` through the
 *                        substrate's runOperation pipeline so calls
 *                        are journaled + emit the canonical phase
 *                        contract envelopes
 *   - `listTools()`   — discovery; era codec normalizes the response
 *   - `state`         — lifecycle state; subscribers observe via
 *                        `mcp:<scopeId>:state` bus envelopes
 *   - `close()`       — terminal; cancels reconnect timer + closes
 *                        the SDK client + transport
 *
 * Inbound server-to-client requests:
 *   - `elicitation/create` — handled (#4). The SDK's
 *     `ElicitRequestSchema` handler is installed at client
 *     construction and routes through the per-call
 *     {@link ElicitationHarnessProtocol} slot (`opts.elicitResolver`
 *     on {@link callTool}). Translation lives in `./elicit-bridge.ts`.
 *   - `sampling/createMessage`, `roots/list` — pending (#5 onward).
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md
 */

import { Effect } from "effect";
import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime-next";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
} from "@agentick/spec-next";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import type { ElicitationHarnessProtocol } from "@agentick/spec-next";

import { McpLifecycle } from "./lifecycle.js";
import type { McpClientHarnessOptions, McpClientState, McpToolDescriptor } from "./types.js";
import type { EraCodec } from "./era-codec.js";
import { DraftPassthroughCodec, selectCodec } from "./era-codec.js";
import { makeElicitRequestHandler, type ElicitResolverSlot } from "./elicit-bridge.js";

// ============================================================================
// Errors
// ============================================================================

export interface McpClientNotReadyError {
  readonly _tag: "McpClientNotReadyError";
  readonly state: McpClientState;
  readonly serverId: string;
}

export interface McpTransportError {
  readonly _tag: "McpTransportError";
  readonly cause: unknown;
  readonly serverId: string;
}

export type McpClientError = McpClientNotReadyError | McpTransportError;

// ============================================================================
// Harness
// ============================================================================

/**
 * Per-server MCP client. Construct one per `serverId`; never share
 * across (server, auth) tuples — the auth + connection lifecycle is
 * per-server, not per-session.
 */
export class McpClientHarness extends BaseHarness<"mcp"> {
  private readonly serverId: string;
  private readonly options: McpClientHarnessOptions;
  private readonly lifecycle: McpLifecycle;
  private codec: EraCodec;
  private client: Client | undefined;
  /**
   * Per-call elicit resolver. Set+cleared around each {@link callTool}
   * invocation that passes `opts.elicitResolver`. The SDK's
   * `ElicitRequestSchema` handler (installed in {@link makeClient})
   * reads from this slot when the server fires `elicitation/create`.
   *
   * Single-slot v0 — see `./elicit-bridge.ts` for the concurrency
   * caveat. Concurrent elicit-routed `callTool` invocations through
   * the SAME harness instance share this slot; correlation-id
   * disambiguation is deferred until MCP ships stable
   * `relatedRequestId` on inbound requests.
   */
  private activeElicitResolver: ElicitationHarnessProtocol | undefined;
  private readonly elicitResolverSlot: ElicitResolverSlot = {
    current: () => this.activeElicitResolver,
  };

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: McpClientHarnessOptions,
  ) {
    super("mcp", scopeId, journal, bus, inbox);
    this.serverId = options.serverId;
    this.options = options;
    this.codec = options.codec ?? DraftPassthroughCodec;
    this.lifecycle = new McpLifecycle({
      ...(options.reconnect !== undefined ? { reconnect: options.reconnect } : {}),
      onReconnect: () => this.reconnect(),
      onStateChange: (state) => this.publishStateChange(state),
    });
  }

  get id(): string {
    return this.scopeId;
  }

  get state(): McpClientState {
    return this.lifecycle.state;
  }

  /**
   * Open the transport, perform the MCP `initialize` handshake, and
   * select an era codec based on the server's reported protocol
   * version. Subsequent `callTool` / `listTools` calls only succeed
   * after this resolves.
   *
   * Idempotent — calling on a `ready` harness is a no-op.
   */
  async connect(): Promise<void> {
    if (this.lifecycle.state === "ready") return;
    if (this.lifecycle.state === "closed") {
      throw new Error(`McpClientHarness "${this.serverId}" is closed`);
    }

    this.lifecycle.markConnecting();
    try {
      const client = this.makeClient();
      this.wireClientEvents(client);
      await client.connect(this.options.transport);
      this.client = client;

      // Era selection — pick the codec for the protocol version the
      // server reported. SDK strips this onto the Client during
      // initialize; we inspect via getServerVersion (a misnomer in
      // the SDK — returns Implementation, not version string).
      const serverVersion = client.getServerVersion();
      this.codec = selectCodec(
        (serverVersion as { protocolVersion?: string } | undefined)?.protocolVersion ??
          this.options.codec?.era,
      );

      this.lifecycle.markReady();
    } catch (err) {
      this.lifecycle.markDisconnected();
      throw err;
    }
  }

  /**
   * Discover the server's tools. Era codec normalizes each entry to
   * the canonical {@link McpToolDescriptor} shape.
   */
  listTools(): Promise<readonly McpToolDescriptor[]> {
    const op: Operation<undefined, readonly McpToolDescriptor[]> = {
      opId: `mcp:${this.serverId}:list-tools:${ulid()}`,
      surface: "mcp",
      name: "mcp:command:list-tools",
      scope: { sessionId: this.scopeId },
      input: undefined,
    };
    return runHarnessProtocol(
      this.runOperation(op, () =>
        Effect.tryPromise({
          try: async () => {
            const c = this.requireReadyClient();
            const res = await c.listTools();
            return (res.tools as Tool[]).map((t) =>
              this.codec.decodeTool(t as unknown as Readonly<Record<string, unknown>>),
            );
          },
          catch: (cause) => cause as McpClientError,
        }),
      ),
    );
  }

  /**
   * Call a tool on the server. Wraps `tools/call`; result is the raw
   * SDK shape — the `withMCP` ToolBridge (#3) maps it into the local
   * ToolExecutor's `ContentBlock[]` shape.
   *
   * `opts.elicitResolver` activates inbound elicit routing for the
   * duration of this call. When the server fires `elicitation/create`
   * while this call is in flight, the SDK's registered handler routes
   * the request through the supplied {@link ElicitationHarnessProtocol}.
   * Single-slot per harness (see {@link activeElicitResolver}) — if
   * two concurrent elicit-routed calls land on the same harness, the
   * second one's resolver overwrites the first.
   */
  callTool(
    name: string,
    args?: Readonly<Record<string, unknown>>,
    opts?: { readonly elicitResolver?: ElicitationHarnessProtocol },
  ): Promise<CallToolResult> {
    const op: Operation<{ name: string; args: typeof args }, CallToolResult> = {
      opId: `mcp:${this.serverId}:call-tool:${ulid()}`,
      surface: "mcp",
      name: "mcp:command:call-tool",
      scope: { sessionId: this.scopeId },
      input: { name, args },
    };
    const prior = this.activeElicitResolver;
    if (opts?.elicitResolver !== undefined) {
      this.activeElicitResolver = opts.elicitResolver;
    }
    const restore = (): void => {
      if (opts?.elicitResolver !== undefined) {
        this.activeElicitResolver = prior;
      }
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: async (): Promise<CallToolResult> => {
            const c = this.requireReadyClient();
            try {
              // SDK's `callTool` return type is a union covering a legacy
              // `{toolResult}` shape; cast to the modern `{content}`
              // shape so downstream consumers (ToolBridge in #3) work
              // against one type.
              const res = (await c.callTool({
                name: i.name,
                arguments: i.args as Record<string, unknown> | undefined,
              })) as CallToolResult;
              return res;
            } finally {
              restore();
            }
          },
          catch: (cause) => {
            restore();
            return cause as McpClientError;
          },
        }),
      ),
    );
  }

  /**
   * Terminal shutdown. Cancels any pending reconnect, closes the SDK
   * client + transport, transitions lifecycle to `closed`. Idempotent.
   */
  override async close(): Promise<void> {
    this.lifecycle.close();
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Underlying transport close errors aren't actionable here —
        // we're tearing down; the substrate close handlers run next.
      }
      this.client = undefined;
    }
    await super.close();
  }

  // ─────────── lifecycle helpers ───────────

  /**
   * Reconnect attempt — called by the lifecycle when the backoff
   * timer fires. The harness reuses the configured transport
   * instance; transports that aren't reusable (stdio's subprocess
   * exited) must be replaced externally before reconnect can
   * succeed.
   */
  private async reconnect(): Promise<void> {
    // Tear down the existing client if any (the old transport
    // reference may still be alive).
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        /* ignore */
      }
      this.client = undefined;
    }
    const client = this.makeClient();
    this.wireClientEvents(client);
    await client.connect(this.options.transport);
    this.client = client;
    this.lifecycle.markReady();
  }

  /**
   * Test-only — fires a pending reconnect timer immediately so tests
   * don't sleep through real backoff delays.
   */
  triggerReconnectNow(): void {
    this.lifecycle.triggerReconnectNow();
  }

  /**
   * Diagnostic — current era codec the harness uses to decode wire
   * responses. Useful for assertions in tests.
   */
  currentCodec(): EraCodec {
    return this.codec;
  }

  // ─────────── inbox ───────────

  /**
   * No subclass-specific inbox messages today. `request-response`
   * envelopes (for future server-initiated request flows) are
   * intercepted by `BaseHarness.dispatchMessage` before this method
   * runs. Anything else is a routing bug — fail loud.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: `Unknown mcp message type: ${String((msg as { type?: string }).type)}`,
    });
  }

  // ─────────── internals ───────────

  private makeClient(): Client {
    const capabilities = (this.options.capabilities ?? {
      // Substrate-required: elicitation form-mode is always declared
      // so MCP servers can elicit from the user. URL mode + roots /
      // sampling capabilities mix in when the corresponding bridge
      // is wired (#4, #5).
      elicitation: { form: {} },
    }) as Record<string, unknown>;
    const client = new Client(
      {
        name: this.options.clientInfo?.name ?? "@agentick/mcp-client",
        version: this.options.clientInfo?.version ?? "1.0.0",
      },
      { capabilities },
    );
    // Bind the inbound `elicitation/create` handler once at client
    // construction. The handler reads the per-call resolver slot at
    // dispatch time; an empty slot returns `{ action: "cancel" }` so
    // unrouted elicits terminate cleanly on the server's side.
    client.setRequestHandler(
      ElicitRequestSchema,
      makeElicitRequestHandler(this.elicitResolverSlot),
    );
    return client;
  }

  private wireClientEvents(client: Client): void {
    client.onclose = () => {
      // Distinguish caller-initiated close from transport drops:
      // caller-initiated close transitions to `closed` BEFORE the
      // SDK calls onclose; transport drops fire while still in
      // `ready`. Only the latter triggers reconnect.
      if (this.lifecycle.state === "ready" || this.lifecycle.state === "connecting") {
        this.lifecycle.markDisconnected();
      }
    };
    // onerror is intentionally NOT wired in #2 — error semantics differ
    // per transport (SDK's `UnauthorizedError` from HTTP transports
    // belongs to #5; subprocess crashes from stdio drop through
    // onclose). The reconnect path covers transport-level failures.
  }

  private requireReadyClient(): Client {
    if (this.lifecycle.state !== "ready" || !this.client) {
      throw {
        _tag: "McpClientNotReadyError",
        state: this.lifecycle.state,
        serverId: this.serverId,
      } satisfies McpClientNotReadyError;
    }
    return this.client;
  }

  private publishStateChange(state: McpClientState): void {
    // Fire-and-forget bus emit. The envelope name uses the harness's
    // surface + a state-change action so observers can subscribe with
    // `{ surface: "mcp", name: { exact: "mcp:<scopeId>:state" } }`.
    void Effect.runPromise(
      this.bus.append({
        id: ulid(),
        surface: "mcp",
        name: `mcp:${this.scopeId}:state`,
        phase: "delta",
        timestamp: Date.now(),
        scope: { sessionId: this.scopeId },
        payload: { state, serverId: this.serverId },
      } as import("@agentick/spec-next").ProtocolEvent),
    );
  }
}
