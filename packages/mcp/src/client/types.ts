/**
 * Core client types — state machine, options, MCP spec eras.
 *
 * Kept narrow to avoid pulling SDK internals into adopters' code; the
 * harness file wires these together with the SDK `Client` / `Transport`
 * shapes.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CreateMessageRequest, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";
import type { ContentBlock, McpRoot, ResourceContents } from "@agentick/spec";
import type { McpAuth } from "./auth.js";
import type { EraCodec } from "./era-codec.js";
import type { BaseHarnessOptions } from "@agentick/runtime";

// ============================================================================
// State machine
// ============================================================================

/**
 * Lifecycle states a per-server MCP client transitions through. The
 * state is published on the bus as `mcp:<scopeId>:state` envelopes;
 * subscribers can observe + react.
 *
 *   idle          — constructed but not yet connect()ed
 *   connecting    — connect() in flight, handshake not done
 *   ready         — connected, handshake complete, RPCs flow
 *   degraded      — past the reconnect ceiling; manual recovery only
 *   reconnecting  — transport dropped; backoff timer running
 *   closed        — close() called; terminal
 */
export type McpClientState =
  | "idle"
  | "connecting"
  | "ready"
  | "degraded"
  | "reconnecting"
  | "closed";

// ============================================================================
// MCP spec eras
// ============================================================================

/**
 * MCP protocol versions the client can talk to. The canonical shape inside the
 * harness mirrors the NEWEST era; era codecs translate at the wire edge, so
 * adopters interact with one shape regardless of what the remote speaks.
 *
 *   2024-11-05  — legacy, supported but discouraged
 *   2025-11-25  — previous official
 *   2026-07-28  — current official, and what canonical mirrors
 *
 * ## Why canonical tracks the NEWEST era
 *
 * Because compatibility burden should sit on the side that is going away. With
 * canonical on the newest era, an older era's codec absorbs the differences —
 * `initialize`, protocol-level sessions, server-initiated requests — and gets
 * DELETED when that era's deprecation window closes. Pin canonical to an older
 * era instead and every future era pays a translation cost forever, in the
 * direction that is growing.
 *
 * `"draft"` is gone as an era value but still ACCEPTED on the wire: servers
 * built against the pre-publication draft report it, and `selectCodec` maps it
 * to canonical rather than failing them.
 */
export type McpSpecEra = "2024-11-05" | "2025-11-25" | "2026-07-28";

// ============================================================================
// Construction options
// ============================================================================

/**
 * Options for {@link McpClientHarness}. The harness is constructed
 * with a fully-built transport and auth strategy — the `withMCP()`
 * extension (#3) wires these from declarative server configs.
 */
/**
 * `extends BaseHarnessOptions` so `parentScope`, `principal`, telemetry and the
 * interceptor fold reach the harness. Standing alone, this interface made every base
 * slot unpassable, and the constructor's `super(...)` took no options at all — so an
 * MCP harness emitted events scoped to its own doubly-composed key
 * (`<sessionId>:mcp:<serverId>`) that no session subscription could match.
 */
export interface McpClientHarnessOptions extends BaseHarnessOptions<unknown, "mcp"> {
  /**
   * Server id surfaced as the harness's scope (`mcp:<serverId>`).
   * Used for envelope routing + tool-registration keys downstream.
   */
  readonly serverId: string;

  /**
   * Pluggable transport. Pass a `Transport` from the SDK (StdioClientTransport,
   * StreamableHTTPClientTransport, ...) or a workspace-local impl
   * (`InMemoryMcpTransport`, etc.).
   */
  readonly transport: Transport;

  /**
   * Authentication strategy. {@link NoneAuth} for stdio, {@link BearerAuth}
   * for static API keys, OAuth21 (lands in #5) for hosted servers.
   */
  readonly auth: McpAuth;

  /**
   * MCP era codec. Defaults to the draft passthrough; older eras
   * codec to/from canonical at the wire edge.
   */
  readonly codec?: EraCodec;

  /**
   * Client identity surfaced in the `initialize` handshake. Defaults
   * to `@agentick/mcp-client` / `1.0.0`.
   */
  readonly clientInfo?: {
    readonly name: string;
    readonly version: string;
  };

  /**
   * Client capability declaration sent in the `initialize` handshake.
   * Defaults declare elicitation (`form` mode) — the substrate's
   * required surface. URL mode + roots / sampling capabilities get
   * mixed in by `withMCP()` based on the server config.
   */
  readonly capabilities?: Readonly<Record<string, unknown>>;

  /**
   * Reconnect policy. Disabled by default for stdio (subprocess died
   * → escalate to caller). For HTTP transports the `withMCP()`
   * extension flips it on.
   */
  readonly reconnect?: ReconnectPolicy;

  /**
   * Fixed inbox address of the elicit harness this client routes
   * inbound `elicitation/create` messages to. Per-session
   * construction (`withMCP` as SessionExtension) wires the session's
   * elicit harness here — one address per harness, no cross-session
   * routing, no slot.
   *
   * Omitted → inbound elicits cancel cleanly + emit
   * `mcp:warning:routing-dropped` on the bus. Safe default for
   * harness instances that aren't expected to receive
   * server-initiated elicits.
   */
  readonly elicitAddress?: string;

  /**
   * Default timeout (ms) for inbound elicit round-trips. Bounds the
   * Deferred the SDK handler awaits. Defaults to 5 minutes — long
   * enough for a human-in-the-loop, short enough to free the call's
   * fiber on user inactivity.
   */
  readonly elicitTimeoutMs?: number;

  /**
   * Rebuild the transport with a fresh `interactive` setting (#277b
   * Commit B). When `withMCP({ transport: factory })` is in play, the
   * extension installs this closure so the harness can re-run the
   * factory with `interactive: true` during `reauthenticate()` — the
   * only caller-side path that should fire the OAuth URL elicit.
   *
   * Omitted → `reauthenticate()` falls back to `disconnect() + connect()`
   * against the original transport (the bootstrap shape; useful for
   * non-OAuth servers + adopters who pre-built a transport).
   */
  readonly rebuildTransport?: (deps: {
    readonly interactive: boolean;
  }) => Promise<Transport> | Transport;

  /**
   * Handler for inbound `sampling/createMessage` requests (server →
   * client). When set, the harness registers a `CreateMessageRequestSchema`
   * handler and advertises the `sampling` client capability. The
   * handler receives the server's sampling request params and returns
   * a `CreateMessageResult` (the generated message).
   *
   * Omitted → the `sampling` capability is NOT advertised and inbound
   * `sampling/createMessage` requests get the SDK's automatic
   * method-not-found error. The harness does not fake a response.
   *
   * Routing sampling to agentick's OWN executor by default is a Wave 3
   * concern (needs an ADR); Wave 2 restores only the handler seam
   * taking an adopter-provided handler.
   */
  readonly samplingHandler?: McpSamplingHandler;

  /**
   * Filesystem roots offered to the server on `roots/list` (client →
   * server, server-initiated). When set, the harness registers a
   * `ListRootsRequestSchema` handler and advertises
   * `roots: { listChanged: true }`. Accepts either a static list or a
   * provider function (re-evaluated on each `roots/list`).
   *
   * Omitted → the `roots` capability is NOT advertised.
   *
   * The source is PLUGGABLE (ADR 65): a static list, an adopter provider
   * fn, or the sandbox adapter. The sandbox↔roots adapter
   * (`sandboxRootsSource` / `bindSandboxRootsToClient`) lives OUTSIDE this
   * package, in `@agentick/sandbox/mcp`, so the MCP client core stays
   * decoupled from the sandbox (no dep, no cycle). The seam is exactly
   * this provider fn — see {@link McpRootsSource}.
   */
  readonly roots?: McpRootsSource;
}

// ============================================================================
// Sampling (server → client)
// ============================================================================

/**
 * Adopter-provided handler for inbound `sampling/createMessage`
 * requests. Typed against the SDK request params / result — sampling
 * is inherently an MCP-protocol seam, so the wire shapes ARE the
 * contract (matching the v1 client's `samplingHandler`).
 *
 * `extra.signal` aborts if the server cancels the request or the
 * connection drops.
 */
export type McpSamplingHandler = (
  params: CreateMessageRequest["params"],
  extra: { readonly signal: AbortSignal },
) => Promise<CreateMessageResult> | CreateMessageResult;

// ============================================================================
// Roots (client → server)
// ============================================================================

/**
 * Re-export of the canonical {@link McpRoot} (home: `@agentick/spec`)
 * so adopters constructing a roots source don't import spec directly. The
 * single shape is shared with the inbound direction (`ctx.mcp.clientRoots`).
 */
export type { McpRoot };

/**
 * Source of the roots list offered to a remote server. Either a fixed
 * array or a provider function re-evaluated on each `roots/list` request
 * (so a live source — e.g. the sandbox adapter — reflects mount changes).
 *
 * This IS the pluggable seam (ADR 65): a static list keeps roots usable
 * standalone with no sandbox in the graph; a provider fn lets the sandbox
 * adapter (`@agentick/sandbox/mcp`) project workspace + mounts.
 *
 * TODO(#237-4b / ADR-65): roots-registry upgrade path — if a unified,
 * inspectable, cross-source mount registry is ever needed, a RootsHarness
 * slots UNDER this provider-fn seam (provider reads from it; inbound writes
 * to it; add wire enumerate+subscribe). See ADR 65 for the trigger + rationale.
 */
export type McpRootsSource =
  | readonly McpRoot[]
  | (() => readonly McpRoot[] | Promise<readonly McpRoot[]>);

// ============================================================================
// Logging (server → client notifications)
// ============================================================================

/** MCP `logging/setLevel` severity levels (RFC 5424 syslog ordering). */
export type McpLoggingLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

/** A single `notifications/message` log entry forwarded by the server. */
export interface McpLogMessage {
  readonly level: McpLoggingLevel;
  readonly logger?: string;
  readonly data: unknown;
}

// ============================================================================
// Resource descriptors (canonical shapes)
// ============================================================================

/** A resource advertised by the server on `resources/list`. */
export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

/** A parameterized resource advertised on `resources/templates/list`. */
export interface McpResourceTemplateDescriptor {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/** One page of a `resources/list` response (cursor first-class). */
export interface McpResourcePage {
  readonly resources: readonly McpResourceDescriptor[];
  readonly nextCursor?: string;
}

/** One page of a `resources/templates/list` response. */
export interface McpResourceTemplatePage {
  readonly templates: readonly McpResourceTemplateDescriptor[];
  readonly nextCursor?: string;
}

// ============================================================================
// Prompt descriptors (canonical shapes)
// ============================================================================

/** A single argument a prompt accepts. */
export interface McpPromptArgumentDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

/** A prompt advertised by the server on `prompts/list`. */
export interface McpPromptDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly McpPromptArgumentDescriptor[];
}

/** One page of a `prompts/list` response (cursor first-class). */
export interface McpPromptPage {
  readonly prompts: readonly McpPromptDescriptor[];
  readonly nextCursor?: string;
}

/** A single message in a `prompts/get` result, content-typed. */
export interface McpPromptMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly ContentBlock[];
}

/** A `prompts/get` result — description + content-typed messages. */
export interface McpGetPromptResult {
  readonly description?: string;
  readonly messages: readonly McpPromptMessage[];
}

/**
 * The `context` half of a `completion/complete` request — the sibling
 * arguments the caller has already filled, which is what makes a
 * conditional completion answerable (the phases of *that* job).
 *
 * Shaped exactly like the SDK's `CompleteRequest["params"]["context"]`
 * (`arguments` optional), because the harness forwards it onto the wire
 * verbatim rather than repacking it. Spec's `PromptsCompleteInput.context`
 * — whose `arguments` is required — satisfies it, so a forwarding resolver
 * passes the composer's siblings straight through.
 */
export interface McpCompletionContext {
  readonly arguments?: Readonly<Record<string, string>>;
}

/**
 * Re-export of the spec resource-contents union for adopters reading
 * `resources/read` results without importing spec directly.
 */
export type { ResourceContents };

export interface ReconnectPolicy {
  /** Maximum reconnect attempts before transitioning to `degraded`. Default: 10. */
  readonly maxAttempts?: number;
  /** Initial backoff (ms). Default: 1000. */
  readonly initialDelayMs?: number;
  /** Cap on the backoff (ms). Default: 30_000. */
  readonly maxDelayMs?: number;
}

// ============================================================================
// Tool descriptors (canonical shape)
// ============================================================================

/**
 * Canonical discovered tool descriptor — the harness's view of a
 * single tool advertised by an MCP server. The era codec maps
 * server-side variants to this shape on `tools/list` responses.
 *
 * Distinct from `@agentick/spec`'s `ToolDeclaration` because the
 * server-supplied shape carries no `handlerRef` (the handler is the
 * MCP server itself, reachable via `callTool`). #3 bridges
 * `McpToolDescriptor` to `ToolDeclaration` + a synthesized
 * handlerRef when registering with the local `ToolExecutor`.
 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
  /**
   * Execution annotations — `taskSupport` lives here per MCP 2025-11-25
   * (and 2026-07-28). Values:
   *   - `"optional"` — task creation allowed but not required.
   *   - `"required"` — task creation mandatory; server returns
   *     `CreateTaskResult` on `tools/call`.
   *   - `"forbidden"` — task creation not allowed; server always
   *     returns `CallToolResult` inline.
   *
   * Distinct from the `annotations` field (which the SDK's
   * `ToolSchema` strict-strips to a fixed set of hint fields).
   * Adopters honoring task support read this field.
   */
  readonly execution?: {
    readonly taskSupport?: "optional" | "required" | "forbidden";
  };
}

/**
 * One page of a `tools/list` response (cursor first-class — the same envelope
 * {@link McpResourcePage} and {@link McpPromptPage} carry). A server with a large
 * catalog advertises it across pages; stopping at the first would silently drop
 * tools from the local registry.
 */
export interface McpToolPage {
  readonly tools: readonly McpToolDescriptor[];
  readonly nextCursor?: string;
}
