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
 *                        substrate's runOperation pipeline (declared
 *                        command, ADR 51) so calls are journaled +
 *                        emit the canonical phase contract envelopes
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
 *   - `sampling/createMessage` — handled (#146) when an adopter
 *     `samplingHandler` is configured; advertises `sampling`. Absent a
 *     handler, the SDK responds method-not-found (no fake model call).
 *   - `roots/list` — handled (#146) when a `roots` source is
 *     configured; advertises `roots: { listChanged }`. The source is
 *     pluggable (ADR 65): a static list, a provider fn, or the sandbox
 *     adapter (`@agentick/sandbox/mcp`) — kept decoupled here.
 *   - `notifications/message` (logging) — surfaced via `onLogMessage`
 *     + the `mcp:<scopeId>:log` bus envelope.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */

import { Effect, Stream } from "effect";
import { BaseHarness, ulid } from "@agentick/runtime";
import type {
  CompletionResult,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  OperationOrigin,
} from "@agentick/spec";
import { HandlerError } from "@agentick/spec";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  GetTaskResultSchema,
  ListRootsRequestSchema,
  ListTasksResultSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  TaskStatusNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  CancelTaskResult,
  GetTaskResult,
  ListTasksResult,
  LoggingMessageNotification,
  ProgressNotification,
  TaskStatusNotification,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { mapResourceContents, mcpContentToBlocks } from "../integration/content-mapper.js";

import {
  buildCallToolAsTaskParams,
  discriminateCallToolResponse,
  extractRelatedTaskId,
  parseTaskPayloadAsCallToolResult,
  TASKS_CANCEL_METHOD,
  TASKS_GET_METHOD,
  TASKS_LIST_METHOD,
  TASKS_RESULT_METHOD,
  type CallToolAsTaskOptions,
  type CallToolOrTaskOutcome,
} from "../wire/task-codec.js";

import type { ElicitationResult } from "@agentick/spec";
import type { RequestResponseRegistry } from "@agentick/runtime";
import {
  createLocalPubSub,
  createNotifier,
  type LocalPubSub,
  type Notifier,
} from "@agentick/pubsub";

import { McpLifecycle } from "./lifecycle.js";
import type {
  McpClientHarnessOptions,
  McpClientState,
  McpCompletionContext,
  McpGetPromptResult,
  McpLogMessage,
  McpLoggingLevel,
  McpPromptPage,
  McpResourcePage,
  McpResourceTemplatePage,
  McpRoot,
  McpToolPage,
  ResourceContents,
} from "./types.js";
import type { McpConnectionStatus, StatusUnsubscribe } from "./connection-status.js";
import type { EraCodec } from "./era-codec.js";
import { CanonicalPassthroughCodec, selectCodec } from "./era-codec.js";
import { makeElicitRequestHandler } from "./elicit-bridge.js";
import { omitUndefined } from "@agentick/utils";

/**
 * Bound on the `err.cause` walk in {@link findCredentialsRequired}.
 * Defensive — a malformed cause cycle (e.g. `a.cause = b; b.cause = a`)
 * would otherwise spin forever. Eight links is well beyond anything
 * the SDK wraps in practice (typical depth is 1–2: the provider's
 * throw nested under `UnhandledRequestError`).
 */
const MAX_CAUSE_CHAIN_DEPTH = 8;

/**
 * Walk an error chain (`err.cause` recursion) looking for an
 * {@link McpCredentialsRequiredError}. The SDK frequently wraps
 * provider-thrown errors as `UnhandledRequestError` or generic
 * `Error`, so structural detection at the leaf is the only reliable
 * lift. Returns `undefined` when no link in the chain matches.
 */
function findCredentialsRequired(err: unknown): McpCredentialsRequiredError | undefined {
  let cursor: unknown = err;
  for (let i = 0; i < MAX_CAUSE_CHAIN_DEPTH && cursor !== null && cursor !== undefined; i++) {
    if (cursor instanceof McpCredentialsRequiredError) return cursor;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Lift the wire-protocol `McpClientState` (managed by {@link McpLifecycle})
 * into the adopter-facing {@link McpConnectionStatus}. The two FSMs sit
 * at different abstraction layers:
 *
 *   - Wire-level: `idle / connecting / ready / degraded / reconnecting / closed`
 *     — tracks the SDK Client + the auto-reconnect-with-backoff curve.
 *   - Adopter-facing: `disconnected / connecting / connected /
 *     credentials-missing / credentials-expired / error` — adds
 *     credential-state bucketing that the wire layer doesn't see.
 *
 * Credential-aware states (`credentials-missing` / `credentials-expired`)
 * aren't reachable via this lift — they come from auth-rejection
 * bucketing during connect, set explicitly. The lift covers the
 * transport-level state mapping; the harness's `connect()` catch
 * block layers credential states on top.
 */
function liftLifecycleState(state: McpClientState): McpConnectionStatus {
  switch (state) {
    case "ready":
      return { kind: "connected" };
    case "connecting":
    case "reconnecting":
      return { kind: "connecting" };
    case "degraded":
      return { kind: "error", reason: "transport drop; reconnect exhausted" };
    case "closed":
    case "idle":
      return { kind: "disconnected" };
  }
}

/**
 * Discriminated event published to {@link McpClientHarness.taskNotificationBus}.
 * Stream subscribers filter on `taskId` (and optionally `kind`) to
 * receive the slice they care about. Routing the two inbound channels
 * through one bus avoids the parallel-map drift that ADR-34
 * consolidation calls out.
 */
type TaskNotificationEvent =
  | {
      readonly kind: "status";
      readonly taskId: string;
      readonly notification: TaskStatusNotification;
    }
  | {
      readonly kind: "progress";
      readonly taskId: string;
      readonly notification: ProgressNotification;
    };

/**
 * Discriminated event fired when an MCP server sends one of the
 * catalog-change notifications: `notifications/tools/list_changed`,
 * `notifications/prompts/list_changed`, or
 * `notifications/resources/list_changed`. Payload carries only the
 * discriminator — the MCP protocol notification itself has no params;
 * consumers are expected to re-fetch the affected list (`tools/list`,
 * etc.) to get the new contents.
 *
 * Well-behaved MCP servers emit these when their catalog mutates
 * server-side. Not every server does; if a server never emits, our
 * client's cache stays stale until manual refresh. That's the
 * protocol contract — no polling fallback here.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md
 * @see spec.modelcontextprotocol.io — notifications/*_list_changed
 */
export type McpListChangedEvent =
  | { readonly kind: "tools" }
  | { readonly kind: "prompts" }
  | { readonly kind: "resources" };

/**
 * Synchronous snapshot of one connected server's identity + advertised
 * capabilities — keyed by the ADOPTER ALIAS (`serverId`, the config
 * `id`), NOT the server's self-reported name. Powers the `mcpServerInfo`
 * compiler-surfacing default projection (ADR 63) and adopter dashboards.
 *
 * **Trust boundary.** `serverId` is adopter-assigned and trust-safe —
 * it governs every namespace (tool prefixes, surfaced resource aliases,
 * this projection's key). `implementation.name` / `.version` come from
 * the server's `initialize` handshake and are an UNTRUSTED DISPLAY
 * LABEL: a server may report any name (including one colliding with
 * another server's alias) and it can never shadow another alias's
 * namespace.
 *
 * `implementation` / `capabilities` are `null` before a successful
 * handshake (disconnected / connecting / errored).
 */
export interface McpServerInfo {
  /** Adopter alias (config `serverId`) — the trust-safe namespace key. */
  readonly serverId: string;
  /** Current adopter-facing connection status. */
  readonly status: McpConnectionStatus;
  /** Server's self-reported name/version. UNTRUSTED display label. */
  readonly implementation: { readonly name: string; readonly version: string } | null;
  /** Capability map the server advertised in `initialize`, if connected. */
  readonly capabilities: Readonly<Record<string, unknown>> | null;
}

/** A declared command's public invoker (ADR 51). */
type Cmd<I, R> = (input: I, opts?: { readonly origin?: OperationOrigin }) => Promise<R>;

/**
 * Serializable payload of `mcp:call-tool` — the positional
 * `callTool(name, args)` signature folded into one command input.
 */
type McpCallToolInput = {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>> | undefined;
};

/**
 * Serializable payload of `mcp:call-tool-as-task` — the `tools/call`
 * params with the draft `task` augmentation, as built by
 * {@link buildCallToolAsTaskParams}.
 */
type CallToolAsTaskParams = ReturnType<typeof buildCallToolAsTaskParams>;

/** Serializable payload of the paginated list verbs. */
type McpCursorInput = { readonly cursor: string | undefined };

/** Serializable payload of `mcp:read-resource`. */
type McpReadResourceInput = { readonly uri: string };

/** Serializable payload of `mcp:get-prompt`. */
type McpGetPromptInput = {
  readonly name: string;
  readonly args: Readonly<Record<string, string>> | undefined;
};

/**
 * Serializable payload of `mcp:complete` — the completion `ref`
 * discriminant plus the argument being completed. Covers both
 * `ref/prompt` (prompt argument) and `ref/resource` (resource-template
 * variable) completions.
 */
type McpCompleteInput = {
  readonly ref:
    | { readonly type: "ref/prompt"; readonly name: string }
    | { readonly type: "ref/resource"; readonly uri: string };
  readonly argument: { readonly name: string; readonly value: string };
  /** Sibling arguments already filled — MCP's `params.context`. */
  readonly context?: McpCompletionContext;
};

/** Serializable payload of `mcp:set-logging-level`. */
type McpSetLoggingLevelInput = { readonly level: McpLoggingLevel };

// ============================================================================
// Errors
// ============================================================================

/** Migrated to class hierarchy (ADR 41). Re-exports from @agentick/spec. */
export {
  McpClientError,
  type McpClientErrorChannel,
  McpClientNotReadyError,
  McpCredentialsRequiredError,
  McpTransportError,
} from "@agentick/spec";
import { McpClientNotReadyError, McpCredentialsRequiredError } from "@agentick/spec";
import type { McpClientError } from "@agentick/spec";

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
   * Active SDK Transport used by the next `connect()`. Initialized from
   * `options.transport`; replaced by `reauthenticate()` when a
   * {@link McpClientHarnessOptions.rebuildTransport} closure is wired,
   * so the OAuth-interactive transport replaces the optimistic one for
   * the duration of the re-auth attempt.
   */
  private currentTransport: import("@modelcontextprotocol/sdk/shared/transport.js").Transport;
  /**
   * Fixed elicit-harness inbox address — set at construction by
   * `withMCP` to the owning session's elicit harness address. The
   * SDK's `ElicitRequestSchema` handler routes inbound
   * `elicitation/create` messages here via the substrate's inbox
   * (cluster-friendly: LocalInbox in-process, ClusterInbox across
   * nodes).
   *
   * Per-session construction (#151) means each MCP connection serves
   * exactly one session. No slot. No cross-session routing.
   * Concurrent elicits from the same session use the
   * RequestResponseRegistry's per-correlationId Deferreds.
   *
   * `undefined` → inbound elicits cancel cleanly and emit
   * `mcp:warning:routing-dropped` on the bus.
   */
  private readonly elicitAddress: string | undefined;

  /**
   * Single fan-out bus for inbound task notifications. Each inbound
   * `notifications/tasks/status` or `notifications/progress` becomes
   * one published `TaskNotificationEvent`; per-taskId subscribers
   * filter at subscribe time. Replaces two parallel
   * `Map<taskId, Set<callback>>` registries with one Stream-shaped
   * primitive (see `@agentick/pubsub`).
   *
   * Channels carried:
   *   - `kind: "status"` — `notifications/tasks/status` (terminal +
   *     intermediate status transitions). `taskId` is direct.
   *   - `kind: "progress"` — `notifications/progress` with the
   *     related-task meta key (`RELATED_TASK_META_KEY`). `taskId` is
   *     derived via `matchProgressNotificationForTask`.
   */
  private readonly taskNotificationBus: LocalPubSub<TaskNotificationEvent> =
    createLocalPubSub<TaskNotificationEvent>();
  /**
   * Notifier for `notifications/tools/list_changed`,
   * `notifications/prompts/list_changed`, and
   * `notifications/resources/list_changed` — the MCP protocol's
   * catalog-mutation signals. Callback-based (mirrors the
   * {@link statusNotifier} pattern) so consumers don't need Effect
   * ceremony to react.
   *
   * The handler fires AFTER the SDK's internal notification dispatch;
   * subscribers may safely call {@link listTools} to get the refreshed
   * catalog. Fire-and-forget — subscriber exceptions are trapped by
   * the notifier and don't affect the harness lifecycle.
   *
   * @see McpListChangedEvent
   */
  private readonly listChangedNotifier: Notifier<McpListChangedEvent> =
    createNotifier<McpListChangedEvent>();

  /**
   * Notifier for inbound `notifications/message` server logs. The SDK
   * `LoggingMessageNotificationSchema` handler (registered in
   * {@link makeClient}) fans each entry to subscribers via
   * {@link onLogMessage}. Callback-based (mirrors {@link listChangedNotifier})
   * so consumers don't need Effect ceremony. Also mirrored to the bus
   * as `mcp:<scopeId>:log` for substrate observers.
   */
  private readonly logNotifier: Notifier<McpLogMessage> = createNotifier<McpLogMessage>();

  /**
   * Adopter-facing connection status — the {@link McpConnectionStatus}
   * union. Layered above the wire-level {@link McpClientState}; the
   * harness's lifecycle callback (constructor) lifts each transition
   * into this FSM via {@link liftLifecycleState}. Credential-aware
   * kinds (`credentials-missing` / `credentials-expired`) are set
   * explicitly by `connect()`'s catch block when the OAuth provider
   * surfaces an auth failure (follow-up slice).
   */
  private _status: McpConnectionStatus = { kind: "disconnected" };
  private readonly statusNotifier: Notifier<McpConnectionStatus> =
    createNotifier<McpConnectionStatus>();
  /**
   * Promise of the current in-flight connect attempt — used to
   * de-dup concurrent `connect()` calls + as a race-token for the
   * status-update guards in the connect IIFE. `undefined` between
   * attempts.
   */
  private inFlightConnect: Promise<void> | undefined;
  /**
   * Promise of the current in-flight disconnect attempt — same
   * de-dup + serialization role for the disconnect path. A
   * `connect()` arriving while disconnect is mid-await waits on
   * the disconnect to settle before proceeding; without this gate
   * the new SDK Client would race with the still-closing old one.
   */
  private inFlightDisconnect: Promise<void> | undefined;

  // ─── Declared commands (ADR 51) — assigned in the constructor ───
  private readonly listToolsCmd: Cmd<McpCursorInput, McpToolPage>;
  private readonly callToolCmd: Cmd<McpCallToolInput, CallToolResult>;
  private readonly callToolAsTaskCmd: Cmd<CallToolAsTaskParams, CallToolOrTaskOutcome>;
  private readonly getTaskCmd: Cmd<{ readonly taskId: string }, GetTaskResult>;
  private readonly getTaskResultCmd: Cmd<{ readonly taskId: string }, CallToolResult>;
  private readonly listTasksCmd: Cmd<Readonly<Record<string, never>>, ListTasksResult>;
  private readonly cancelTaskCmd: Cmd<{ readonly taskId: string }, CancelTaskResult>;
  // ─── Wave 2: resources / prompts / completion / logging ───
  private readonly listResourcesCmd: Cmd<McpCursorInput, McpResourcePage>;
  private readonly listResourceTemplatesCmd: Cmd<McpCursorInput, McpResourceTemplatePage>;
  private readonly readResourceCmd: Cmd<McpReadResourceInput, readonly ResourceContents[]>;
  private readonly listPromptsCmd: Cmd<McpCursorInput, McpPromptPage>;
  private readonly getPromptCmd: Cmd<McpGetPromptInput, McpGetPromptResult>;
  private readonly completeCmd: Cmd<McpCompleteInput, CompletionResult>;
  private readonly setLoggingLevelCmd: Cmd<McpSetLoggingLevelInput, void>;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: McpClientHarnessOptions,
  ) {
    // Forward the WHOLE bag. This `super` took no options at all, so every base
    // slot a caller passed — `parentScope` included — was silently discarded.
    super("mcp", scopeId, journal, bus, inbox, options);
    this.serverId = options.serverId;
    this.options = options;
    this.currentTransport = options.transport;
    this.codec = options.codec ?? CanonicalPassthroughCodec;
    this.elicitAddress = options.elicitAddress;
    this.lifecycle = new McpLifecycle({
      ...omitUndefined({ reconnect: options.reconnect }),
      onReconnect: () => this.recycleClient(),
      onStateChange: (state) => {
        // Two-channel fan-out:
        //   1. bus envelope `mcp:<scopeId>:state` — substrate
        //      subscribers reach via the canonical name
        //   2. adopter-facing status — lift the wire state into the
        //      `McpConnectionStatus` union and notify status
        //      subscribers. Skipped when a connect() catch block has
        //      already moved status to a credential-aware kind we
        //      don't want overwritten.
        this.publishStateChange(state);
        const lifted = liftLifecycleState(state);
        // Avoid clobbering credential-aware status set explicitly by
        // a connect() catch block — those override the wire lift.
        if (
          this._status.kind === "credentials-missing" ||
          this._status.kind === "credentials-expired"
        ) {
          return;
        }
        if (this._status.kind === lifted.kind) return;
        this.setStatus(lifted);
      },
    });

    // ─── Declared commands (ADR 51) — the single declaration site per
    // verb. Inbox message types, canonical op naming (`mcp:command:*`),
    // enumeration, and (future, matrix-gated) wire methods all derive
    // from these; the hand-built Operation literals are gone. Payloads
    // carried no validation before the registry; schemas stay off for
    // parity. Connection lifecycle (connect / disconnect / reconnect /
    // reauthenticate) is NOT declared — those verbs bind transports +
    // auth strategies (non-serializable, construction-bound; ADR 51
    // §1.2) and never ran through runOperation to begin with.
    // NO scope factory. This harness's `scopeId` is DOUBLY composed
    // (`<sessionId>:mcp:<serverId>`), so stamping it as `sessionId` put a value on
    // every envelope that no session-scoped subscription could ever match. The
    // owning session arrives via `parentScope` at construction.
    this.listToolsCmd = this.command({
      name: "mcp:list-tools",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      handler: (i: McpCursorInput) => this.listToolsBody(i),
    });
    this.callToolCmd = this.command({
      name: "mcp:call-tool",
      handler: (i: McpCallToolInput) => this.callToolBody(i),
    });
    this.callToolAsTaskCmd = this.command({
      name: "mcp:call-tool-as-task",
      handler: (i: CallToolAsTaskParams) => this.callToolAsTaskBody(i),
    });
    this.getTaskCmd = this.command({
      name: "mcp:get-task",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      handler: (i: { readonly taskId: string }) => this.getTaskBody(i),
    });
    this.getTaskResultCmd = this.command({
      name: "mcp:get-task-result",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      handler: (i: { readonly taskId: string }) => this.getTaskResultBody(i),
    });
    this.listTasksCmd = this.command({
      name: "mcp:list-tasks",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      handler: () => this.listTasksBody(),
    });
    this.cancelTaskCmd = this.command({
      name: "mcp:cancel-task",
      // VERB-MATRIX ratified wire row (#140/#141) — grantable, deny-by-default.
      exposure: "wire",
      handler: (i: { readonly taskId: string }) => this.cancelTaskBody(i),
    });

    // ─── Wave 2 reads (#146) — resources / prompts / completion /
    // logging. Declared as ADDRESSABLE commands (journaled + inbox-
    // reachable), NOT `exposure: "wire"`: the client-read verbs were
    // never ratified into the #140/#141 VERB-MATRIX, so exposing them
    // to remote grantees is a separate security-surface decision.
    // TODO(#146-later): promote to `exposure: "wire"` once a verb-matrix
    // row is ratified for external resource/prompt reads.
    this.listResourcesCmd = this.command({
      name: "mcp:list-resources",
      handler: (i: McpCursorInput) => this.listResourcesBody(i),
    });
    this.listResourceTemplatesCmd = this.command({
      name: "mcp:list-resource-templates",
      handler: (i: McpCursorInput) => this.listResourceTemplatesBody(i),
    });
    this.readResourceCmd = this.command({
      name: "mcp:read-resource",
      handler: (i: McpReadResourceInput) => this.readResourceBody(i),
    });
    this.listPromptsCmd = this.command({
      name: "mcp:list-prompts",
      handler: (i: McpCursorInput) => this.listPromptsBody(i),
    });
    this.getPromptCmd = this.command({
      name: "mcp:get-prompt",
      handler: (i: McpGetPromptInput) => this.getPromptBody(i),
    });
    this.completeCmd = this.command({
      name: "mcp:complete",
      handler: (i: McpCompleteInput) => this.completeBody(i),
    });
    this.setLoggingLevelCmd = this.command({
      name: "mcp:set-logging-level",
      handler: (i: McpSetLoggingLevelInput) => this.setLoggingLevelBody(i),
    });
  }

  // ============================================================================
  // Adopter-facing connection-status surface (#277b)
  // ============================================================================

  /** Current adopter-facing connection status. */
  get status(): McpConnectionStatus {
    return this._status;
  }

  /**
   * Synchronous {@link McpServerInfo} snapshot — identity + advertised
   * capabilities keyed by the adopter alias (`serverId`). See
   * {@link McpServerInfo} for the trust boundary (self-reported name is
   * an untrusted display label). Read by the `mcpServerInfo` default
   * projection + adopter status UIs.
   */
  get serverInfo(): McpServerInfo {
    const impl = this.client?.getServerVersion();
    const caps = this.client?.getServerCapabilities();
    return {
      serverId: this.serverId,
      status: this._status,
      implementation: impl !== undefined ? { name: impl.name, version: impl.version } : null,
      capabilities: caps !== undefined ? (caps as Readonly<Record<string, unknown>>) : null,
    };
  }

  /**
   * Subscribe to connection-status transitions. Listener fires
   * synchronously after each transition with the new status. Returns
   * an unsubscribe function. Listener errors are caught per-listener
   * — a buggy consumer cannot corrupt sibling listeners.
   *
   * The current status is NOT replayed at subscribe time; use
   * {@link status} for the snapshot. Subscribe for future transitions.
   */
  onStatusChange(listener: (status: McpConnectionStatus) => void): StatusUnsubscribe {
    return this.statusNotifier.subscribe(listener);
  }

  /**
   * Subscribe to MCP-protocol catalog-change notifications forwarded
   * from the connected server:
   *
   *   - `notifications/tools/list_changed`     → `{ kind: "tools" }`
   *   - `notifications/prompts/list_changed`   → `{ kind: "prompts" }`
   *   - `notifications/resources/list_changed` → `{ kind: "resources" }`
   *
   * Payloads carry only the discriminator (the MCP notification
   * itself has no params); subscribers re-fetch the affected list
   * (via {@link listTools}) to get the new contents.
   *
   * Fire-and-forget — a listener throwing does NOT affect siblings
   * or the harness lifecycle (the underlying Notifier traps per
   * listener). Returns an unsubscribe function.
   *
   * Not replayed on subscribe — the notification is a transient
   * signal, not a state snapshot. Subscribe BEFORE `connect()` if
   * you need to catch every emission from the very start of the
   * session.
   */
  onListChanged(listener: (event: McpListChangedEvent) => void): () => void {
    return this.listChangedNotifier.subscribe(listener);
  }

  /** Internal helper — updates `_status` and notifies subscribers. */
  private setStatus(next: McpConnectionStatus): void {
    this._status = next;
    this.statusNotifier.notify(next);
  }

  /**
   * Map a `connect()` failure to the terminal {@link McpConnectionStatus}
   * the harness should surface (#277b Commit B).
   *
   *   - `McpCredentialsRequiredError` (kind=missing|expired) → bucket
   *     into `credentials-missing` / `credentials-expired`. These are
   *     UI-actionable: the adopter renders a "Sign in" button bound
   *     to {@link reauthenticate}.
   *   - everything else → `error` with the underlying message.
   *
   * Walks `error.cause` so the lift survives the SDK's wrappers
   * (`UnhandledRequestError` etc.).
   */
  private classifyConnectFailure(err: unknown): McpConnectionStatus {
    const credErr = findCredentialsRequired(err);
    if (credErr) {
      return credErr.kind === "missing"
        ? { kind: "credentials-missing" }
        : { kind: "credentials-expired", reason: credErr.message };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: "error", reason };
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
   * Idempotent — calling on a `ready` harness is a no-op. Concurrent
   * calls are de-duped via the in-flight Promise. The status FSM
   * transitions `disconnected → connecting → connected` on success,
   * `→ error` on failure (with reason). A concurrent
   * {@link disconnect} that fires during the await chain wins; the
   * connect attempt's late outcome doesn't clobber `disconnected`.
   */
  async connect(): Promise<void> {
    if (this.lifecycle.state === "ready") return;
    if (this.lifecycle.state === "closed") {
      throw new Error(`McpClientHarness "${this.serverId}" is closed`);
    }
    if (this.inFlightConnect) return this.inFlightConnect;
    // Serialize against any in-flight disconnect — its `client.close()`
    // needs to finish before we construct a fresh client, otherwise
    // we race two SDK Clients over the same transport.
    if (this.inFlightDisconnect) await this.inFlightDisconnect;

    // markConnecting fires the lifecycle's onStateChange callback,
    // which lifts to setStatus({ kind: "connecting" }) — no explicit
    // call needed here (would double-emit).
    this.lifecycle.markConnecting();

    this.inFlightConnect = (async () => {
      try {
        const client = this.makeClient();
        this.wireClientEvents(client);
        await client.connect(this.currentTransport);
        // Race check: a concurrent `disconnect()` could have moved
        // the status away from `connecting` while we awaited
        // `client.connect`. If so, the user's intent wins — close
        // the late-arriving client and bail without touching status.
        if (this._status.kind !== "connecting") {
          try {
            await client.close();
          } catch {
            /* close errors moot — handle already moved on */
          }
          return;
        }
        this.client = client;

        // Era selection — pick the codec for the protocol version
        // the server reported. SDK strips this onto the Client
        // during initialize; we inspect via getServerVersion (a
        // misnomer in the SDK — returns Implementation, not version
        // string).
        const serverVersion = client.getServerVersion();
        this.codec = selectCodec(
          (serverVersion as { protocolVersion?: string } | undefined)?.protocolVersion ??
            this.options.codec?.era,
        );

        this.lifecycle.markReady();
        // The lifecycle's onStateChange callback lifts `ready` to
        // `connected` via setStatus — no explicit call needed here.
      } catch (err) {
        // Race-guarded: only bucket into a terminal status if status
        // is still `connecting`. A concurrent disconnect would have
        // moved status to `disconnected`; don't clobber the user's
        // intent.
        //
        // Order matters: classify-and-set BEFORE markDisconnected.
        // Without a reconnect policy markDisconnected transitions
        // straight to `degraded`, whose lift is `error` — that would
        // clobber a credentials-* classification. The lifecycle's
        // onStateChange callback has a credential-aware skip guard
        // so once we set credentials-*, the lift won't overwrite.
        // For non-credential errors we let the lift assign `error`
        // (the prior behavior) — explicit setStatus would only
        // duplicate the emission.
        const classified =
          this._status.kind === "connecting" ? this.classifyConnectFailure(err) : undefined;
        if (
          classified &&
          (classified.kind === "credentials-missing" || classified.kind === "credentials-expired")
        ) {
          this.setStatus(classified);
        }
        this.lifecycle.markDisconnected();
        // Non-credential errors: if the lift didn't run (status was
        // already non-connecting), still surface as `error`.
        if (classified && classified.kind === "error" && this._status.kind === "connecting") {
          this.setStatus(classified);
        }
        throw err;
      } finally {
        this.inFlightConnect = undefined;
      }
    })();
    return this.inFlightConnect;
  }

  /**
   * User-initiated disconnect — closes the SDK Client + transitions
   * to `disconnected`. Does NOT terminate the harness; subsequent
   * `connect()` / `reconnect()` calls open a fresh client (re-using
   * the same `options.transport` reference — adopters needing fresh
   * transports per reconnect cycle use `TransportFactory` at the
   * `withMCP` level, not the harness).
   *
   * Idempotent — no-op when already `disconnected`. Race-safe
   * against concurrent `connect()` via the status guards in the
   * connect IIFE.
   */
  async disconnect(): Promise<void> {
    if (this._status.kind === "disconnected") return;
    if (this.inFlightDisconnect) return this.inFlightDisconnect;

    // Set status FIRST so any in-flight connect's race-guard sees
    // the intent and bails without overwriting.
    this.setStatus({ kind: "disconnected" });
    // Pause the lifecycle so the auto-reconnect curve doesn't fire
    // after our intentional close.
    this.lifecycle.pause();
    const client = this.client;
    this.client = undefined;

    this.inFlightDisconnect = (async () => {
      try {
        if (client) {
          try {
            await client.close();
          } catch {
            // Close errors are diagnostic, not actionable — we've
            // already moved the harness to disconnected; surfacing
            // a throw here would only confuse adopters.
          }
        }
      } finally {
        this.inFlightDisconnect = undefined;
      }
    })();
    return this.inFlightDisconnect;
  }

  /**
   * `disconnect()` + `connect()` in sequence. Convenience for "I
   * suspect the wire is stale, try again" — does NOT delete stored
   * credentials. For OAuth-backed servers, use {@link reauthenticate}
   * if you want the OAuth dance to fire (delete + re-auth).
   */
  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  /**
   * Re-run the auth flow — interactively.
   *
   *   1. Disconnect (release the current transport / SDK Client).
   *   2. Rebuild the transport with `interactive: true` so the OAuth
   *      provider fires the URL-mode elicit when it needs an auth
   *      code. Without a {@link McpClientHarnessOptions.rebuildTransport}
   *      closure (pre-built `Transport`, no factory), the harness
   *      reuses the original transport — useful for non-OAuth flows
   *      where reauthenticate degenerates to a full reconnect.
   *   3. Connect.
   *
   * The only caller-side path that opens the OAuth dance. `connect()`
   * / `reconnect()` build with `interactive: false` and short-circuit
   * via `McpCredentialsRequiredError` instead of prompting.
   *
   * Failures from the rebuild step surface as `error` status; if the
   * interactive connect itself fails the classifier may still bucket
   * into `credentials-expired` (refresh exhausted) or `error`.
   */
  async reauthenticate(): Promise<void> {
    await this.disconnect();
    if (this.options.rebuildTransport) {
      try {
        this.currentTransport = await this.options.rebuildTransport({ interactive: true });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.setStatus({ kind: "error", reason });
        throw err;
      }
    }
    await this.connect();
  }

  /**
   * Discover the server's tools, ONE PAGE at a time. Era codec normalizes each
   * entry to the canonical descriptor shape ({@link McpToolPage}).
   *
   * Same pagination contract as {@link listPrompts} / {@link listResources}: the
   * `cursor` passes through untouched and the returned `nextCursor` (when
   * present) feeds the next call. A caller that wants the whole catalog walks
   * until `nextCursor` is absent — which is what tool discovery does
   * (`discoverAndRegisterTools`), because a server with more tools than one page
   * would otherwise register a truncated set with no error to explain it.
   */
  listTools(cursor?: string): Promise<McpToolPage> {
    return this.listToolsCmd({ cursor });
  }

  private listToolsBody(i: McpCursorInput): Effect.Effect<McpToolPage, McpClientError, never> {
    return Effect.tryPromise({
      try: async (): Promise<McpToolPage> => {
        const c = this.requireReadyClient();
        const res = await c.listTools(i.cursor !== undefined ? { cursor: i.cursor } : undefined);
        return {
          tools: (res.tools as Tool[]).map((t) =>
            this.codec.decodeTool(t as unknown as Readonly<Record<string, unknown>>),
          ),
          ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
        };
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  /**
   * Call a tool on the server. Wraps `tools/call`; result is the raw
   * SDK shape — the `withMCP` ToolBridge maps it into the local
   * ToolExecutor's `ContentBlock[]` shape.
   *
   * Inbound elicits during this call route to the harness's
   * construction-time `elicitAddress`. Per-session harness
   * construction (#151) means no slot, no cross-session race —
   * concurrency is solved by construction.
   */
  callTool(name: string, args?: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
    return this.callToolCmd({ name, args });
  }

  private callToolBody(i: McpCallToolInput): Effect.Effect<CallToolResult, McpClientError, never> {
    return Effect.tryPromise({
      try: async (): Promise<CallToolResult> => {
        const c = this.requireReadyClient();
        // SDK's `callTool` return type is a union covering a legacy
        // `{toolResult}` shape; cast to the modern `{content}`
        // shape so downstream consumers (ToolBridge) work against
        // one type.
        const res = (await c.callTool({
          name: i.name,
          arguments: i.args as Record<string, unknown> | undefined,
        })) as CallToolResult;
        return res;
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  // ─────────── Task wire (draft tasks/* extension) ───────────

  /**
   * Call a tool with task-augmented params (`task: { ttl?, pollInterval? }`).
   * The server may honor by returning a `CreateTaskResult` (task
   * created; lifecycle proceeds via `notifications/tasks/status` +
   * `tasks/result`) OR execute inline by returning a regular
   * `CallToolResult`.
   *
   * Both shapes are normalized into a single discriminated outcome —
   * callers branch on `_tag`. The codec uses the SDK's
   * `CreateTaskResultSchema` / `CallToolResultSchema` for parsing, so
   * the outcome's payload is fully typed.
   *
   * Inbound elicits during the call route to the harness's
   * construction-time `elicitAddress` (same as `callTool`).
   */
  callToolAsTask(
    name: string,
    args: Readonly<Record<string, unknown>> | undefined,
    opts: CallToolAsTaskOptions = {},
  ): Promise<CallToolOrTaskOutcome> {
    return this.callToolAsTaskCmd(buildCallToolAsTaskParams(name, args, opts));
  }

  private callToolAsTaskBody(
    i: CallToolAsTaskParams,
  ): Effect.Effect<CallToolOrTaskOutcome, McpClientError, never> {
    return Effect.tryPromise({
      try: async (): Promise<CallToolOrTaskOutcome> => {
        const c = this.requireReadyClient();
        // We can't use `c.callTool(...)` here — its SDK signature
        // strips the `task` param. Use the underlying request()
        // with the SDK's CallToolResult schema; the server's
        // response may match either CreateTaskResult or
        // CallToolResult, so we re-discriminate against the
        // codec.
        const raw = await c.request(
          { method: "tools/call", params: i as Record<string, unknown> },
          CallToolResultSchema.passthrough(),
        );
        return discriminateCallToolResponse(raw);
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  /**
   * Subscribe to inbound notifications scoped to `taskId`. Returns an
   * Effect Stream of either status or progress notifications; the
   * stream stays open until the consumer detaches (via `Stream.take`,
   * `Fiber.interrupt`, etc.) or the harness closes.
   *
   * Status notifications match by `params.taskId` (per
   * `TaskStatusNotificationParamsSchema`); progress notifications
   * match via the `_meta["io.modelcontextprotocol/related-task"]`
   * association (per `RELATED_TASK_META_KEY`).
   *
   * Discriminated by `kind` so adopters fold into local state without
   * a second runtime type check.
   */
  taskNotifications(
    taskId: string,
  ): Stream.Stream<
    | { readonly kind: "status"; readonly notification: TaskStatusNotification }
    | { readonly kind: "progress"; readonly notification: ProgressNotification },
    never,
    never
  > {
    type Out =
      | { readonly kind: "status"; readonly notification: TaskStatusNotification }
      | { readonly kind: "progress"; readonly notification: ProgressNotification };
    return Stream.map(
      this.taskNotificationBus.subscribe((event) => event.taskId === taskId),
      (event): Out =>
        event.kind === "status"
          ? { kind: "status", notification: event.notification }
          : { kind: "progress", notification: event.notification },
    );
  }

  /**
   * Send `tasks/get` for a snapshot of the remote task's state.
   */
  getTask(taskId: string): Promise<GetTaskResult> {
    return this.getTaskCmd({ taskId });
  }

  private getTaskBody(i: {
    readonly taskId: string;
  }): Effect.Effect<GetTaskResult, McpClientError, never> {
    return Effect.tryPromise({
      try: async (): Promise<GetTaskResult> => {
        const c = this.requireReadyClient();
        return await c.request(
          { method: TASKS_GET_METHOD, params: { taskId: i.taskId } },
          GetTaskResultSchema,
        );
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  /**
   * Send `tasks/result` to retrieve the final payload of a completed
   * `tools/call` task. The payload IS the original `CallToolResult`
   * shape; this method parses against `CallToolResultSchema` for
   * type-safe content blocks.
   */
  getTaskResult(taskId: string): Promise<CallToolResult> {
    return this.getTaskResultCmd({ taskId });
  }

  private getTaskResultBody(i: {
    readonly taskId: string;
  }): Effect.Effect<CallToolResult, McpClientError, never> {
    return Effect.tryPromise({
      try: async (): Promise<CallToolResult> => {
        const c = this.requireReadyClient();
        // tasks/result returns the original request's result shape
        // (loose); for tools/call tasks that means the payload IS
        // a CallToolResult. Re-parse via the codec for type safety.
        const raw = await c.request(
          { method: TASKS_RESULT_METHOD, params: { taskId: i.taskId } },
          CallToolResultSchema.passthrough(),
        );
        return parseTaskPayloadAsCallToolResult(raw);
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  /**
   * Send `tasks/list` and return the server's snapshot of every task
   * it knows about (in-flight + terminal-still-within-TTL). Used by
   * the framework's `task_list` model-facing tool (#175) to
   * give the model visibility into remote tasks that may have been
   * spawned by other sessions sharing the server, persisted across a
   * reconnect, or otherwise lack a live local proxy.
   *
   * Throws if the server didn't advertise tasks support or if the
   * connection isn't ready. Callers SHOULD catch + degrade — a
   * non-tasks-aware MCP server is a normal configuration.
   */
  listTasks(): Promise<ListTasksResult> {
    return this.listTasksCmd({});
  }

  private listTasksBody(): Effect.Effect<ListTasksResult, McpClientError, never> {
    return Effect.tryPromise({
      try: async (): Promise<ListTasksResult> => {
        const c = this.requireReadyClient();
        return await c.request({ method: TASKS_LIST_METHOD }, ListTasksResultSchema);
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  /**
   * Send `tasks/cancel`. Idempotent on the server side per spec —
   * cancelling an already-terminal task returns the current task
   * snapshot without effect.
   */
  cancelTask(taskId: string): Promise<CancelTaskResult> {
    return this.cancelTaskCmd({ taskId });
  }

  private cancelTaskBody(i: {
    readonly taskId: string;
  }): Effect.Effect<CancelTaskResult, McpClientError, never> {
    return Effect.tryPromise({
      try: async (): Promise<CancelTaskResult> => {
        const c = this.requireReadyClient();
        return await c.request(
          { method: TASKS_CANCEL_METHOD, params: { taskId: i.taskId } },
          CancelTaskResultSchema,
        );
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  // ═════════════════════════════════════════════════════════════════
  // Wave 2 — Resources (read)
  // ═════════════════════════════════════════════════════════════════

  /**
   * List the resources the server advertises. Pagination `cursor` is
   * passed through untouched; the returned `nextCursor` (when present)
   * feeds the next call.
   */
  listResources(cursor?: string): Promise<McpResourcePage> {
    return this.listResourcesCmd({ cursor });
  }

  private listResourcesBody(i: McpCursorInput): Effect.Effect<McpResourcePage, McpClientError> {
    return Effect.tryPromise({
      try: async (): Promise<McpResourcePage> => {
        const c = this.requireReadyClient();
        const res = await c.listResources(
          i.cursor !== undefined ? { cursor: i.cursor } : undefined,
        );
        return {
          resources: res.resources.map((r) => ({
            uri: r.uri,
            name: r.name,
            ...omitUndefined({
              title: r.title,
              description: r.description,
              mimeType: r.mimeType,
              size: r.size,
            }),
          })),
          ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
        };
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  /**
   * List the parameterized resource templates the server advertises.
   * Same pagination contract as {@link listResources}.
   */
  listResourceTemplates(cursor?: string): Promise<McpResourceTemplatePage> {
    return this.listResourceTemplatesCmd({ cursor });
  }

  private listResourceTemplatesBody(
    i: McpCursorInput,
  ): Effect.Effect<McpResourceTemplatePage, McpClientError> {
    return Effect.tryPromise({
      try: async (): Promise<McpResourceTemplatePage> => {
        const c = this.requireReadyClient();
        const res = await c.listResourceTemplates(
          i.cursor !== undefined ? { cursor: i.cursor } : undefined,
        );
        return {
          templates: res.resourceTemplates.map((t) => ({
            uriTemplate: t.uriTemplate,
            name: t.name,
            ...omitUndefined({
              title: t.title,
              description: t.description,
              mimeType: t.mimeType,
            }),
          })),
          ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
        };
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  /**
   * Read a resource by URI. Contents map through the content-typing
   * layer to the spec {@link ResourceContents} shape — `text` for UTF-8
   * bodies, `blob` (base64) for binary — so a read round-trips without
   * loss into agentick's content model.
   */
  readResource(uri: string): Promise<readonly ResourceContents[]> {
    return this.readResourceCmd({ uri });
  }

  private readResourceBody(
    i: McpReadResourceInput,
  ): Effect.Effect<readonly ResourceContents[], McpClientError> {
    return Effect.tryPromise({
      try: async (): Promise<readonly ResourceContents[]> => {
        const c = this.requireReadyClient();
        const res = await c.readResource({ uri: i.uri });
        return mapResourceContents(res.contents);
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  // ═════════════════════════════════════════════════════════════════
  // Wave 2 — Prompts (read)
  // ═════════════════════════════════════════════════════════════════

  /** List the prompts the server advertises. Cursor pagination. */
  listPrompts(cursor?: string): Promise<McpPromptPage> {
    return this.listPromptsCmd({ cursor });
  }

  private listPromptsBody(i: McpCursorInput): Effect.Effect<McpPromptPage, McpClientError> {
    return Effect.tryPromise({
      try: async (): Promise<McpPromptPage> => {
        const c = this.requireReadyClient();
        const res = await c.listPrompts(i.cursor !== undefined ? { cursor: i.cursor } : undefined);
        return {
          prompts: res.prompts.map((p) => ({
            name: p.name,
            ...omitUndefined({ title: p.title, description: p.description }),
            ...(p.arguments
              ? {
                  arguments: p.arguments.map((a) => ({
                    name: a.name,
                    ...omitUndefined({ description: a.description, required: a.required }),
                  })),
                }
              : {}),
          })),
          ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
        };
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  /**
   * Get a prompt by name with optional string arguments. The prompt's
   * messages map through the content-typing layer (embedded resources
   * become {@link ResourceContents} blocks, not text JSON).
   */
  getPrompt(name: string, args?: Readonly<Record<string, string>>): Promise<McpGetPromptResult> {
    return this.getPromptCmd({ name, args });
  }

  private getPromptBody(i: McpGetPromptInput): Effect.Effect<McpGetPromptResult, McpClientError> {
    return Effect.tryPromise({
      try: async (): Promise<McpGetPromptResult> => {
        const c = this.requireReadyClient();
        const res = await c.getPrompt({
          name: i.name,
          ...(i.args !== undefined ? { arguments: i.args as Record<string, string> } : {}),
        });
        return {
          ...omitUndefined({ description: res.description }),
          messages: res.messages.map((m) => ({
            role: m.role,
            // A PromptMessage carries a SINGLE content object; wrap in a
            // one-element array so the shared block mapper handles the
            // text/image/audio/resource/resource_link union uniformly.
            content: mcpContentToBlocks([m.content] as unknown as CallToolResult["content"]),
          })),
        };
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  // ═════════════════════════════════════════════════════════════════
  // Wave 2 — Completion
  // ═════════════════════════════════════════════════════════════════

  /**
   * Request argument completions for a prompt argument (`ref/prompt`).
   *
   * Answers the full {@link CompletionResult} — `values` plus the server's
   * `total` / `hasMore` when it reported them. Those two fields are the reason
   * this is not a bare `string[]`: MCP caps a response at 100 values and flags
   * the truncation, and a FORWARDING resolver (an MCP-origin prompt whose
   * completion re-asks its origin server) has to pass that judgment along rather
   * than silently presenting a truncated list as the whole answer. A caller that
   * only wants candidates reads `.values`.
   *
   * `context.arguments` carries the sibling arguments already filled, and is the
   * difference between "which job?" and "which phase of *that* job?" — a
   * forwarding resolver passes its ctx's `resolvedArguments` straight in.
   */
  completePromptArgument(
    promptName: string,
    argumentName: string,
    value: string,
    context?: McpCompletionContext,
  ): Promise<CompletionResult> {
    return this.completeCmd({
      ref: { type: "ref/prompt", name: promptName },
      argument: { name: argumentName, value },
      ...omitUndefined({ context }),
    });
  }

  /**
   * Request completions for a resource-template variable (`ref/resource`).
   * Answers the full {@link CompletionResult} — see
   * {@link completePromptArgument} for why `total` / `hasMore` survive and what
   * `context` buys.
   */
  completeResourceTemplate(
    uriTemplate: string,
    argumentName: string,
    value: string,
    context?: McpCompletionContext,
  ): Promise<CompletionResult> {
    return this.completeCmd({
      ref: { type: "ref/resource", uri: uriTemplate },
      argument: { name: argumentName, value },
      ...omitUndefined({ context }),
    });
  }

  private completeBody(i: McpCompleteInput): Effect.Effect<CompletionResult, McpClientError> {
    return Effect.tryPromise({
      try: async (): Promise<CompletionResult> => {
        const c = this.requireReadyClient();
        // `context` is forwarded verbatim — it is already the wire shape, and a
        // conditional completion on a remote prompt is answerable only with it.
        const res = await c.complete({
          ref: i.ref,
          argument: i.argument,
          ...omitUndefined({ context: i.context }),
        });
        return {
          values: res.completion.values,
          ...omitUndefined({ total: res.completion.total, hasMore: res.completion.hasMore }),
        };
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  // ═════════════════════════════════════════════════════════════════
  // Wave 2 — Logging
  // ═════════════════════════════════════════════════════════════════

  /**
   * Set the minimum severity level the server should emit as
   * `notifications/message` log entries. Subscribe via
   * {@link onLogMessage} to receive them.
   */
  setLoggingLevel(level: McpLoggingLevel): Promise<void> {
    return this.setLoggingLevelCmd({ level });
  }

  private setLoggingLevelBody(i: McpSetLoggingLevelInput): Effect.Effect<void, McpClientError> {
    return Effect.tryPromise({
      try: async (): Promise<void> => {
        const c = this.requireReadyClient();
        await c.setLoggingLevel(i.level);
      },
      catch: (cause) => cause as McpClientError,
    });
  }

  /**
   * Subscribe to inbound `notifications/message` server logs. Listener
   * fires per log entry; returns an unsubscribe function. Fire-and-
   * forget — a throwing listener cannot corrupt siblings (the Notifier
   * traps per listener). Not replayed on subscribe.
   */
  onLogMessage(listener: (message: McpLogMessage) => void): () => void {
    return this.logNotifier.subscribe(listener);
  }

  // ═════════════════════════════════════════════════════════════════
  // Wave 2 — Roots (client → server)
  // ═════════════════════════════════════════════════════════════════

  /**
   * Notify the server that the client's roots list changed
   * (`notifications/roots/list_changed`). Only meaningful when the
   * harness was constructed with a `roots` source (the `roots:
   * { listChanged }` capability is advertised then). No-op-safe to call
   * repeatedly; the server re-requests `roots/list` at its discretion.
   */
  async notifyRootsListChanged(): Promise<void> {
    const c = this.requireReadyClient();
    await c.sendRootsListChanged();
  }

  /**
   * Resolve the configured roots source to a concrete list. A provider
   * function is re-evaluated on each `roots/list` so a live source (the
   * sandbox adapter) reflects mount changes.
   *
   * The source is the pluggable seam (ADR 65): a static list, an adopter
   * provider fn, or the sandbox adapter (`@agentick/sandbox/mcp`,
   * which deps this package — one direction, no cycle). This harness has
   * no knowledge of any source; it just resolves a list.
   *
   * TODO(#237-4b / ADR-65): roots-registry upgrade path — if a unified,
   * inspectable, cross-source mount registry is ever needed, a RootsHarness
   * slots UNDER this provider-fn seam (provider reads from it; inbound writes
   * to it; add wire enumerate+subscribe). See ADR 65 for the trigger + rationale.
   */
  private async resolveRoots(): Promise<readonly McpRoot[]> {
    const src = this.options.roots;
    if (src === undefined) return [];
    const list = typeof src === "function" ? await src() : src;
    return list.map((r) => (r.name !== undefined ? { uri: r.uri, name: r.name } : { uri: r.uri }));
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
    await this.taskNotificationBus.close();
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
  /**
   * Auto-reconnect helper — fired by the lifecycle's reconnect timer
   * after a transport drop. Tears down the existing client, opens a
   * fresh one over the SAME transport reference. Renamed from
   * `reconnect()` so the public `reconnect()` verb (user-initiated
   * disconnect + reconnect cycle) is free for the connection-status
   * lifecycle.
   */
  private async recycleClient(): Promise<void> {
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
    await client.connect(this.currentTransport);
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
   * All MCP client verbs are DECLARED COMMANDS (ADR 51) — the command
   * registry in `BaseHarness.dispatchMessage` routes
   * `mcp:list-tools/call-tool/call-tool-as-task/get-task/get-task-result/list-tasks/cancel-task`
   * before this fallthrough is ever consulted. `request-response`
   * envelopes (elicitation replies routed back from the elicit
   * harness) are intercepted even earlier by `dispatchMessage`.
   * Server-initiated inbound traffic (elicitation relays, task
   * status/progress notifications, list-changed notifications) is SDK
   * request/notification-handler plumbing on the `Client` — it never
   * arrives as inbox messages, so it is not command material. Anything
   * landing here is a routing bug — fail loud.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({
        cause: `Unknown mcp message type: ${String((msg as { type?: string }).type)}`,
      }),
    );
  }

  // ─────────── internals ───────────

  private makeClient(): Client {
    const capabilities = {
      ...((this.options.capabilities as Record<string, unknown> | undefined) ?? {
        // Substrate-required: both form and URL elicitation modes are
        // declared so MCP servers can elicit from the user via either
        // path. Routing happens at handler dispatch time through the
        // per-call elicit resolver slot.
        elicitation: { form: {}, url: {} },
      }),
    } as Record<string, unknown>;
    // Advertise ONLY what is actually wired (#146). Sampling depends on
    // an adopter-provided handler; roots on a configured source. An
    // unwired capability is never claimed — an inbound request for it
    // gets the SDK's automatic method-not-found (we never fake).
    if (this.options.samplingHandler) capabilities.sampling = {};
    if (this.options.roots !== undefined) capabilities.roots = { listChanged: true };
    const client = new Client(
      {
        name: this.options.clientInfo?.name ?? "@agentick/mcp-client",
        version: this.options.clientInfo?.version ?? "1.0.0",
      },
      { capabilities },
    );
    // Bind the inbound `elicitation/create` handler once at client
    // construction. The handler dispatches inbound elicits to the
    // FIXED `elicitAddress` set at construction — per-session
    // harness construction (#151) means each McpClientHarness serves
    // one session; no slot, no cross-session race.
    client.setRequestHandler(
      ElicitRequestSchema,
      makeElicitRequestHandler({
        elicitAddress: this.elicitAddress,
        inbox: this.inbox,
        bus: this.bus,
        replyToAddress: this.address,
        requests: this.requests as RequestResponseRegistry<ElicitationResult<unknown>>,
        serverId: this.serverId,
        defaultTimeoutMs: this.options.elicitTimeoutMs ?? 5 * 60_000,
      }),
    );
    // Task notification fan-out — once registered, every inbound
    // `notifications/tasks/status` is matched against active task
    // subscribers (keyed by taskId) and offered to each. Subscribers
    // are torn down by the Stream-side `onCancel` in
    // `taskNotifications()` so the maps stay tight.
    client.setNotificationHandler(TaskStatusNotificationSchema, (note) => {
      this.taskNotificationBus.publish({
        kind: "status",
        taskId: note.params.taskId,
        notification: note,
      });
    });
    client.setNotificationHandler(ProgressNotificationSchema, (note) => {
      // Progress notifications carry a related-task key in either
      // params._meta or top-level _meta. We extract the taskId once
      // here; subscribers downstream filter on it via the PubSub.
      const taskId = extractRelatedTaskId(note);
      if (taskId === null) return;
      this.taskNotificationBus.publish({
        kind: "progress",
        taskId,
        notification: note,
      });
    });
    // Catalog-mutation notifications from the MCP server. Payloads
    // are empty per protocol — the notification is JUST a signal, and
    // clients are expected to re-fetch via `tools/list` (etc.) to get
    // the new contents. We fan the signal out through the callback
    // notifier; the withMCP session extension subscribes and re-runs
    // tool discovery. Prompts + resources emit the signal even though
    // McpClientHarness doesn't currently expose fetch methods for
    // them — the wire contract lands here so consumers observing at
    // the harness layer see all three uniformly (spec conformance).
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.listChangedNotifier.notify({ kind: "tools" });
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      this.listChangedNotifier.notify({ kind: "prompts" });
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      this.listChangedNotifier.notify({ kind: "resources" });
    });

    // ─── Wave 2 (#146) inbound server→client seams ───

    // Sampling — the server asks THIS client's model to generate. Only
    // registered when an adopter handler is configured; otherwise the
    // SDK responds method-not-found (we don't fake a model call). The
    // handler seam takes a provided handler; routing sampling to
    // agentick's own executor by default is a Wave-3 ADR concern.
    const samplingHandler = this.options.samplingHandler;
    if (samplingHandler) {
      client.setRequestHandler(CreateMessageRequestSchema, (request, extra) =>
        samplingHandler(request.params, { signal: extra.signal }),
      );
    }

    // Roots — the server asks the client which filesystem roots it may
    // operate on. Registered only when a `roots` source is configured.
    if (this.options.roots !== undefined) {
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: await this.resolveRoots(),
      }));
    }

    // Logging — surface inbound `notifications/message` entries to
    // subscribers (onLogMessage) + mirror to the bus. Always registered;
    // harmless when the server never logs.
    client.setNotificationHandler(LoggingMessageNotificationSchema, (note) => {
      this.publishLogMessage(note);
    });
    return client;
  }

  /**
   * Fan an inbound `notifications/message` out to {@link onLogMessage}
   * subscribers and mirror it to the bus as `mcp:<scopeId>:log`.
   */
  private publishLogMessage(note: LoggingMessageNotification): void {
    const message: McpLogMessage = {
      level: note.params.level as McpLoggingLevel,
      ...(note.params.logger !== undefined ? { logger: note.params.logger } : {}),
      data: note.params.data,
    };
    this.logNotifier.notify(message);
    void Effect.runPromise(
      this.bus.append({
        id: ulid(),
        surface: "mcp",
        name: `mcp:${this.scopeId}:log`,
        phase: "delta",
        timestamp: Date.now(),
        payload: { serverId: this.serverId, ...message },
      } as import("@agentick/spec").ProtocolEvent),
    ).catch(() => {
      // Substrate emit failures aren't actionable in a log fan-out.
    });
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
      throw new McpClientNotReadyError({
        state: this.lifecycle.state,
        serverId: this.serverId,
      });
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
        payload: { state, serverId: this.serverId },
      } as import("@agentick/spec").ProtocolEvent),
    );
  }
}
