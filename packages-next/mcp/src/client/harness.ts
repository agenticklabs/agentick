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

import { Effect, Stream } from "effect";
import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime-next";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
} from "@agentick/spec-next";
import { HandlerError } from "@agentick/spec-next";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  ElicitRequestSchema,
  GetTaskResultSchema,
  ListTasksResultSchema,
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
  ProgressNotification,
  TaskStatusNotification,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

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

import type { ElicitationResult } from "@agentick/spec-next";
import type { RequestResponseRegistry } from "@agentick/runtime-next";
import {
  createLocalPubSub,
  createNotifier,
  type LocalPubSub,
  type Notifier,
} from "@agentick/pubsub-next";

import { McpLifecycle } from "./lifecycle.js";
import type { McpClientHarnessOptions, McpClientState, McpToolDescriptor } from "./types.js";
import type { McpConnectionStatus, StatusUnsubscribe } from "./connection-status.js";
import type { EraCodec } from "./era-codec.js";
import { DraftPassthroughCodec, selectCodec } from "./era-codec.js";
import { makeElicitRequestHandler } from "./elicit-bridge.js";
import { omitUndefined } from "@agentick/utils-next";

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

// ============================================================================
// Errors
// ============================================================================

/** Migrated to class hierarchy (ADR 41). Re-exports from spec-next. */
export {
  McpClientError,
  type McpClientErrorChannel,
  McpClientNotReadyError,
  McpCredentialsRequiredError,
  McpTransportError,
} from "@agentick/spec-next";
import { McpClientNotReadyError, McpCredentialsRequiredError } from "@agentick/spec-next";
import type { McpClientError } from "@agentick/spec-next";

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
   * primitive (see `@agentick/pubsub-next`).
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
    this.currentTransport = options.transport;
    this.codec = options.codec ?? DraftPassthroughCodec;
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
  }

  // ============================================================================
  // Adopter-facing connection-status surface (#277b)
  // ============================================================================

  /** Current adopter-facing connection status. */
  get status(): McpConnectionStatus {
    return this._status;
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
   * SDK shape — the `withMCP` ToolBridge maps it into the local
   * ToolExecutor's `ContentBlock[]` shape.
   *
   * Inbound elicits during this call route to the harness's
   * construction-time `elicitAddress`. Per-session harness
   * construction (#151) means no slot, no cross-session race —
   * concurrency is solved by construction.
   */
  callTool(name: string, args?: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
    const op: Operation<{ name: string; args: typeof args }, CallToolResult> = {
      opId: `mcp:${this.serverId}:call-tool:${ulid()}`,
      surface: "mcp",
      name: "mcp:command:call-tool",
      scope: { sessionId: this.scopeId },
      input: { name, args },
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
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
        }),
      ),
    );
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
    const params = buildCallToolAsTaskParams(name, args, opts);
    const op: Operation<typeof params, CallToolOrTaskOutcome> = {
      opId: `mcp:${this.serverId}:call-tool-as-task:${ulid()}`,
      surface: "mcp",
      name: "mcp:command:call-tool-as-task",
      scope: { sessionId: this.scopeId },
      input: params,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
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
        }),
      ),
    );
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
    const op: Operation<{ taskId: string }, GetTaskResult> = {
      opId: `mcp:${this.serverId}:get-task:${ulid()}`,
      surface: "mcp",
      name: "mcp:command:get-task",
      scope: { sessionId: this.scopeId },
      input: { taskId },
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: async (): Promise<GetTaskResult> => {
            const c = this.requireReadyClient();
            return await c.request(
              { method: TASKS_GET_METHOD, params: { taskId: i.taskId } },
              GetTaskResultSchema,
            );
          },
          catch: (cause) => cause as McpClientError,
        }),
      ),
    );
  }

  /**
   * Send `tasks/result` to retrieve the final payload of a completed
   * `tools/call` task. The payload IS the original `CallToolResult`
   * shape; this method parses against `CallToolResultSchema` for
   * type-safe content blocks.
   */
  getTaskResult(taskId: string): Promise<CallToolResult> {
    const op: Operation<{ taskId: string }, CallToolResult> = {
      opId: `mcp:${this.serverId}:get-task-result:${ulid()}`,
      surface: "mcp",
      name: "mcp:command:get-task-result",
      scope: { sessionId: this.scopeId },
      input: { taskId },
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
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
        }),
      ),
    );
  }

  /**
   * Send `tasks/list` and return the server's snapshot of every task
   * it knows about (in-flight + terminal-still-within-TTL). Used by
   * the framework's `session_tasks_list` model-facing tool (#175) to
   * give the model visibility into remote tasks that may have been
   * spawned by other sessions sharing the server, persisted across a
   * reconnect, or otherwise lack a live local proxy.
   *
   * Throws if the server didn't advertise tasks support or if the
   * connection isn't ready. Callers SHOULD catch + degrade — a
   * non-tasks-aware MCP server is a normal configuration.
   */
  listTasks(): Promise<ListTasksResult> {
    const op: Operation<Readonly<Record<string, never>>, ListTasksResult> = {
      opId: `mcp:${this.serverId}:list-tasks:${ulid()}`,
      surface: "mcp",
      name: "mcp:command:list-tasks",
      scope: { sessionId: this.scopeId },
      input: {},
    };
    return runHarnessProtocol(
      this.runOperation(op, () =>
        Effect.tryPromise({
          try: async (): Promise<ListTasksResult> => {
            const c = this.requireReadyClient();
            return await c.request({ method: TASKS_LIST_METHOD }, ListTasksResultSchema);
          },
          catch: (cause) => cause as McpClientError,
        }),
      ),
    );
  }

  /**
   * Send `tasks/cancel`. Idempotent on the server side per spec —
   * cancelling an already-terminal task returns the current task
   * snapshot without effect.
   */
  cancelTask(taskId: string): Promise<CancelTaskResult> {
    const op: Operation<{ taskId: string }, CancelTaskResult> = {
      opId: `mcp:${this.serverId}:cancel-task:${ulid()}`,
      surface: "mcp",
      name: "mcp:command:cancel-task",
      scope: { sessionId: this.scopeId },
      input: { taskId },
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.tryPromise({
          try: async (): Promise<CancelTaskResult> => {
            const c = this.requireReadyClient();
            return await c.request(
              { method: TASKS_CANCEL_METHOD, params: { taskId: i.taskId } },
              CancelTaskResultSchema,
            );
          },
          catch: (cause) => cause as McpClientError,
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
   * No subclass-specific inbox messages today. `request-response`
   * envelopes (for future server-initiated request flows) are
   * intercepted by `BaseHarness.dispatchMessage` before this method
   * runs. Anything else is a routing bug — fail loud.
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
    const capabilities = (this.options.capabilities ?? {
      // Substrate-required: both form and URL elicitation modes are
      // declared so MCP servers can elicit from the user via either
      // path. Routing happens at handler dispatch time through the
      // per-call elicit resolver slot. Roots / sampling capabilities
      // mix in when those bridges are wired (#5+).
      elicitation: { form: {}, url: {} },
    }) as Record<string, unknown>;
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
        scope: { sessionId: this.scopeId },
        payload: { state, serverId: this.serverId },
      } as import("@agentick/spec-next").ProtocolEvent),
    );
  }
}
