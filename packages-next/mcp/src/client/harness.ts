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
  ProgressNotificationSchema,
  TaskStatusNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  CancelTaskResult,
  GetTaskResult,
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
  TASKS_RESULT_METHOD,
  type CallToolAsTaskOptions,
  type CallToolOrTaskOutcome,
} from "../wire/task-codec.js";

import type { ElicitationResult } from "@agentick/spec-next";
import type { RequestResponseRegistry } from "@agentick/runtime-next";
import { createLocalPubSub, type LocalPubSub } from "@agentick/pubsub-next";

import { McpLifecycle } from "./lifecycle.js";
import type { McpClientHarnessOptions, McpClientState, McpToolDescriptor } from "./types.js";
import type { EraCodec } from "./era-codec.js";
import { DraftPassthroughCodec, selectCodec } from "./era-codec.js";
import { makeElicitRequestHandler } from "./elicit-bridge.js";
import { omitUndefined } from "@agentick/utils-next";

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

// ============================================================================
// Errors
// ============================================================================

/** Migrated to class hierarchy (ADR 41). Re-exports from spec-next. */
export {
  McpClientError,
  type McpClientErrorChannel,
  McpClientNotReadyError,
  McpTransportError,
} from "@agentick/spec-next";
import { McpClientNotReadyError } from "@agentick/spec-next";

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
    this.elicitAddress = options.elicitAddress;
    this.lifecycle = new McpLifecycle({
      ...omitUndefined({ reconnect: options.reconnect }),
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
