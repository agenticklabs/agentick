/**
 * `McpServerHarness` — Shape 1 harness exposing Agentick as MCP server.
 *
 * Symmetric inbound counterpart to `McpClientHarness` (in
 * `@agentick/mcp/client`). Same wire vocabulary, opposite
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
 * @see packages/spec/src/protocol/mcp-server-harness.ts
 */

import { Effect } from "effect";
import {
  BaseHarness,
  deriveObservability,
  deriveOps,
  ulid,
  type Unsubscribe,
} from "@agentick/runtime";
import type {
  EventBus,
  EventScope,
  McpServerConnectionInfo,
  McpServerHarnessProtocol,
  McpRequestContext,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  Prompts,
  Resources,
} from "@agentick/spec";
import { HandlerError, McpServerClosed } from "@agentick/spec";
import { createNotifier, type Notifier } from "@agentick/pubsub";
import { PromptsHarness } from "@agentick/prompts";
import { TasksHarness } from "@agentick/tasks";
import { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  resolveCompletionsOption,
  resolveElicitOption,
  resolvePromptsOption,
  resolveResourcesOption,
  resolveToolsOption,
  type McpServerOptions,
  type PromptsFilter,
  type ResolvedCompletionsOptions,
  type ResolvedToolsOptions,
  validateOptions,
} from "./config.js";
import { buildCapabilities } from "./protocol/lifecycle.js";
import { buildMcpElicit } from "./projection/elicitation.js";
import { installCompletionsHandlers } from "./projection/completions.js";
import {
  createConnectionLogState,
  installLoggingHandler,
  installLogProjection,
  installProgressProjection,
} from "./projection/logging.js";
import { installPromptsHandlers } from "./projection/prompts.js";
import { installClientRootsIngest } from "./projection/roots.js";
import { installResourcesHandlers, type ResourcesFilter } from "./projection/resources.js";
import { createServerTaskRegistry, installTasksHandlers } from "./projection/tasks.js";
import { installToolsHandlers } from "./projection/tools.js";
import { allowAllAuth, resolveSecurity, type ResolvedSecurity } from "./security/index.js";
import { evaluateConnectionGuard, isMcpSecurityError } from "./security/pipeline.js";
import type { McpConnectionInfo } from "./security/stages.js";
import type { AuthPreGate, ServerTransport } from "./transports/types.js";
import { isFalsey, isNull, omitUndefined } from "@agentick/utils";

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
   * Server-side TasksHarness for Pattern B tool returns (#171d.3).
   * One per server; shared across all connections + tools. Tool
   * handlers reach it via `ctx.tasks` in the McpRequestContext.
   * Lifecycle: constructed on harness creation, closed on harness
   * close (cancels every in-flight task).
   */
  private readonly serverTasks: TasksHarness;
  /** True iff any registered tool advertises `taskSupport: "required" | "supported"`. */
  private readonly hasTasksWired: boolean;

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
  private readonly pendingPromptDeclarations: readonly import("@agentick/spec").PromptDeclaration[];
  /** Per-connection prompts visibility predicate (resolved from options). */
  private readonly promptsFilter: PromptsFilter | null;

  /**
   * Adopter-supplied Resources source projected over `resources/*`
   * (ADR 62), or `null` when no resources slot was wired. Always
   * adopter-owned — the server never constructs one (a resource binding
   * needs a resolver function), so `close()` never closes it.
   */
  private readonly resourcesSource: Resources | null;
  /** Per-connection resources visibility predicate (resolved from options). */
  private readonly resourcesFilter: ResourcesFilter | null;

  /** True when `options.elicit` opted into the elicitation capability. */
  private readonly elicitWired: boolean;

  /**
   * Resolved argument-completion handlers, or `null` when no
   * `completions` slot was provided. Consumed per-connection by the
   * completions projection.
   */
  private readonly resolvedCompletions: ResolvedCompletionsOptions | null;
  /**
   * True iff the `completions` capability is advertised — the slot
   * carried at least one handler AND the adopter didn't opt out. Gates
   * both the capability advertisement and installing the
   * `completion/complete` request handler (the SDK asserts the
   * capability on registration).
   */
  private readonly completionsAdvertised: boolean;

  /**
   * True iff structured logging is enabled (ON by default; `false` only
   * when `capabilities.logging === false`). Gates the `logging`
   * capability, the `logging/setLevel` handler, and `ctx.log`.
   */
  private readonly loggingEnabled: boolean;

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
   * The Resources source this server projects over `resources/*`, or
   * `null` if no resources slot was wired (ADR 62). Adopter-owned —
   * register/unregister bindings on it at runtime; the server observes
   * via the notifier and re-projects.
   */
  get resources(): Resources | null {
    return this.resourcesSource;
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

  /**
   * The server-side `TasksHarness` (#171d.3). Adopters introspecting
   * Pattern B tasks running on this server — debug UIs, telemetry,
   * tests — reach it here. Tool handlers reach the same instance via
   * `ctx.tasks!.submit(...)`. Always present (constructed eagerly);
   * `null` would be a special signal we don't need.
   */
  get tasks(): TasksHarness {
    return this.serverTasks;
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

    // Server-side TasksHarness — handles Pattern B tool returns
    // (#171d.3). Constructed eagerly; idle when no Pattern B tool is
    // ever called. Substrate shared with this harness so task
    // envelopes flow through the same bus / journal.
    this.serverTasks = new TasksHarness(`${scopeId}:tasks`, journal, bus, inbox);
    this.hasTasksWired = (this.resolvedTools?.registry.list() ?? []).some((decl) => {
      const ts = decl.annotations?.taskSupport;
      return ts === "required" || ts === "supported";
    });

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

    // Resources are always adopter-owned (no internal construction — a
    // binding needs a resolver function). Resolve the source + filter;
    // the harness only projects the registry, never mutates it.
    if (!isFalsey(this.options.resources)) {
      const resolvedResources = resolveResourcesOption(this.options.resources);
      this.resourcesSource = resolvedResources.use;
      this.resourcesFilter = resolvedResources.filter;
    } else {
      this.resourcesSource = null;
      this.resourcesFilter = null;
    }

    this.elicitWired = resolveElicitOption(this.options.elicit);

    this.resolvedCompletions =
      this.options.completions !== undefined
        ? resolveCompletionsOption(this.options.completions)
        : null;
    this.completionsAdvertised =
      (this.resolvedCompletions?.hasHandlers ?? false) &&
      this.options.capabilities?.completions !== false;

    this.loggingEnabled = this.options.capabilities?.logging !== false;

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

    const preGate = this.buildAuthPreGate();
    for (const transport of this.transports) {
      await transport.listen(async (sdkTransport, info) => {
        await this.acceptConnection(sdkTransport, info);
      }, preGate);
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

    // 4. Close the server-side TasksHarness — cancels every in-flight
    //    Pattern B task with reason "harness_closed" (#171d.3).
    try {
      await this.serverTasks.close();
    } catch {
      /* best-effort */
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
        tools: !isNull(this.resolvedTools) && this.resolvedTools.registry.list().length > 0,
        prompts: !isNull(this.promptsSource),
        // ADR 62 / #237 — advertise `resources: { subscribe, listChanged }`
        // only when a ResourcesHarness is wired. The projection reads the
        // registry and fires updated / list_changed off its notifier.
        resources: !isNull(this.resourcesSource),
        elicitation: this.elicitWired,
        sampling: false, // wired with SamplingHarness
        // #171d.3 — advertise tasks when at least one tool declares
        // taskSupport: "required" | "supported". Pattern B clients
        // gate the task wire on this capability.
        tasks: this.hasTasksWired,
        // Wave 3a — completions advertised when the slot carries a
        // handler; logging advertised by default (every ctx gets a
        // `log` sink). Both subject to `capabilities.*` opt-out.
        completions: this.resolvedCompletions?.hasHandlers ?? false,
        logging: this.loggingEnabled,
      },
      this.options.capabilities,
    );
    // Per-connection instructions (projected into InitializeResult.instructions).
    // Resolved BEFORE SDK Server construction: the SDK reads `instructions`
    // from its options synchronously when answering `initialize`, and the
    // function form may be async — so we await it here and hand the SDK a
    // plain string. `omitUndefined` keeps `instructions` off the wire when
    // unconfigured (the SDK omits a falsy value regardless).
    const instructions = await this.resolveInstructions(info);
    const sdkServer = new SdkServer(this.serverInfo, omitUndefined({ capabilities, instructions }));

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

    // Inbound client roots (ADR 65) — pull the connecting client's
    // `file://` roots (if it advertised the capability) and surface them
    // per-connection on `ctx.mcp.clientRoots`. Handlers register here,
    // BEFORE `sdkServer.connect`, so the first pull (on `oninitialized`)
    // and `roots/list_changed` re-pulls are wired before the transport
    // starts. The holder is scoped to THIS connection — structural
    // isolation, mirroring `connectionScope` for signals.
    const clientRootsIngest = installClientRootsIngest(sdkServer);
    cleanup.push(clientRootsIngest.unsubscribe);

    // 4. Install request-handler projections.

    // Per-connection structured logging (Wave 3a). The level holder is
    // mutated by the `logging/setLevel` handler and read by the
    // `ctx.log` sink. Both are gated on `loggingEnabled` — the SDK
    // asserts the `logging` capability before letting either the
    // setLevel handler register or `sendLoggingMessage` fire.
    // ADR 64 — `ctx.log` / `ctx.progress` no longer write the wire
    // directly. Tool / prompt / completion handlers emit ONE discrete
    // bus event (via `this.emitLog` / `this.emitProgress` below, scoped
    // to this connection); these projections subscribe to that event and
    // forward it to the wire. `connectionScope` is the per-connection
    // filter both projections + the request-ctx emit share.
    const connectionScope: Partial<EventScope> = {
      mcpConnectionId: connectionId,
      mcpServerId: this.scopeId,
    };
    const logState = createConnectionLogState();
    if (this.loggingEnabled) {
      installLoggingHandler(sdkServer, logState);
      cleanup.push(
        installLogProjection({ sdkServer, state: logState, bus: this.bus, connectionScope }),
      );
    }
    // Progress is not capability-gated in the MCP spec (no `setLevel`
    // equivalent) — install unconditionally per connection.
    cleanup.push(installProgressProjection({ sdkServer, bus: this.bus, connectionScope }));

    const buildRequestContext = (): McpRequestContext => {
      // Pull the client's negotiated capabilities + identity from the
      // SDK Server post-initialize. Undefined before initialize
      // completes (which it always has by the time any request handler
      // runs, since the SDK gates requests behind initialize).
      const sdkClientCaps =
        (sdkServer.getClientCapabilities?.() as Readonly<Record<string, unknown>> | undefined) ??
        null;
      const sdkClientInfo = sdkServer.getClientVersion?.() ?? null;
      const clientRoots = clientRootsIngest.current();

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
        // ADR 64/78 — the Observability facet. `log` emits ONE discrete
        // bus event scoped to THIS connection; `installLogProjection`
        // (above) forwards it to the wire (`notifications/message`).
        // `trace`/`metrics` (spread from `observability` below) go to the
        // server's telemetry PROVIDER, NOT the wire — off-path no-ops here
        // until a server-side provider is wired (they never touch the bus,
        // so nothing leaks onto the MCP wire). Fire-and-forget for `log`:
        // launched via `Effect.runFork`, never awaited, never throws.
        ...deriveObservability({
          log: (level, data, logger, trace) => {
            void Effect.runFork(this.emitLog(connectionScope, level, data, logger, trace));
          },
          namespace: this.telemetryNamespace,
        }),
        // ADR 19/83 — the Ops facet (`ctx.run` / `ctx.runner`). The MCP
        // request ctx is assembled OFF-fiber (no enclosing op runtime), so
        // ad-hoc ops run as ROOT ops on this server harness's runner — still
        // journaled + interceptor-folded, just not parented under a caller op.
        ...deriveOps({
          surface: "mcp",
          scope: connectionScope,
          runOperation: this.runOperation.bind(this),
        }),
        progress: (token, p): void => {
          void Effect.runFork(
            this.emitProgress(connectionScope, {
              token,
              progress: p.progress,
              ...(p.total !== undefined ? { total: p.total } : {}),
              ...(p.message !== undefined ? { message: p.message } : {}),
            }),
          );
        },
        task: "auto",
        transport: "mcp" as const,
        // #171d.3 — the server's TasksHarness. Handlers calling
        // `ctx.tasks!.submit(...)` get a TaskHandle that the tools
        // projection layer recognises (via isTaskHandle) and routes
        // to the per-connection task registry → CreateTaskResult on
        // the wire + notifications/tasks/status fan-out.
        tasks: this.serverTasks,
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
          // ADR 65 — inbound roots, read fresh per request so a
          // `roots/list_changed` re-pull is reflected on the next call.
          // Omitted when the client never advertised `roots` (or the
          // first pull hasn't resolved) — advisory, never a control path.
          ...(clientRoots !== undefined ? { clientRoots } : {}),
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

    // Per-connection task registry — bookkeeping for Pattern B tool
    // returns (#171d.3). Built unconditionally when tasks are wired
    // so the tools projection can register handles + the tasks
    // projection can serve tasks/get / tasks/result / tasks/cancel /
    // tasks/list. Cleared on transport close.
    const tasksRegistry = this.hasTasksWired ? createServerTaskRegistry(sdkServer) : undefined;

    if (!isNull(this.resolvedTools) && this.resolvedTools.registry.list().length > 0) {
      const tools = this.resolvedTools;
      const toolsUnsubscribe = installToolsHandlers(sdkServer, {
        registry: tools.registry,
        resolveHandler: tools.resolveHandler,
        ...(tasksRegistry ? { tasks: tasksRegistry } : {}),
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
      cleanup.push(toolsUnsubscribe);
    }

    if (tasksRegistry) {
      installTasksHandlers({ sdkServer, registry: tasksRegistry });
      cleanup.push(() => tasksRegistry.clear());
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

    if (this.resourcesSource !== null) {
      const unsubscribe = installResourcesHandlers(sdkServer, {
        source: this.resourcesSource,
        ...(this.resourcesFilter ? { filter: this.resourcesFilter } : {}),
        security: this.security,
        buildContext: buildRequestContext,
      });
      cleanup.push(unsubscribe);
    }

    // Wave 3a — argument completion. Installed only when the capability
    // is advertised (slot carries a handler AND no opt-out); the SDK
    // asserts the `completions` capability on handler registration.
    if (this.completionsAdvertised && this.resolvedCompletions !== null) {
      const unsubscribe = installCompletionsHandlers(sdkServer, {
        prompts: this.resolvedCompletions.prompts,
        resources: this.resolvedCompletions.resources,
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

  /**
   * Build the HTTP-level auth pre-gate threaded to network transports at
   * `listen()` time (RFC 9728 discovery challenge; ADR 40 §5). This is
   * the harness's half of the enforcement split: `enforce` is set iff the
   * resolved authenticator is a REAL (non-`allowAll`) stage. The transport
   * ANDs it with its own oauth-configured state — the pre-gate fires only
   * when BOTH hold. `verify` runs the SAME configured `Authenticator`
   * (no parallel auth config) against a minimal request context
   * synthesized from the connection snapshot the transport built. Trusted
   * transports (stdio, in-memory) ignore the gate entirely.
   */
  private buildAuthPreGate(): AuthPreGate {
    return {
      enforce: this.security.authenticator !== allowAllAuth,
      verify: async (info) => {
        const result = await this.security.authenticator(this.buildPreGateContext(info));
        return result.authenticated;
      },
    };
  }

  /**
   * Minimal `McpRequestContext` for the HTTP auth pre-gate. Built
   * OFF-connection (no SDK Server / session exists yet — the pre-gate
   * runs before the crossing is handed to the SDK), carrying only the
   * identity material an `Authenticator` reads.
   */
  private buildPreGateContext(info: McpConnectionInfo): McpRequestContext {
    return this.buildOffConnectionContext(info, "pregate");
  }

  /**
   * Build a minimal `McpRequestContext` for a crossing that has no SDK
   * Server / session yet — the auth pre-gate and per-`initialize`
   * instructions resolution both run before the SDK sees the request.
   * Carries only what an `Authenticator` / instructions function reads:
   * the transport-supplied headers / origin / remoteAddress plus the
   * `mcp` discriminator block. Observability + ops facets mirror
   * {@link acceptConnection}'s ctx so a custom authenticator that logs /
   * runs ops behaves identically. `label` distinguishes the synthetic id
   * prefix (`pregate` vs. `init`) for telemetry only.
   */
  private buildOffConnectionContext(
    info: McpConnectionInfo,
    label: "pregate" | "init",
  ): McpRequestContext {
    const connectionScope: Partial<EventScope> = { mcpServerId: this.scopeId };
    return {
      toolCallId: `mcp:${label}:${ulid()}`,
      signal: new AbortController().signal,
      setState: () => {
        /* no-op — no session behind an off-connection crossing */
      },
      emit: () => {
        /* no-op — no channel behind an off-connection crossing */
      },
      ...deriveObservability({
        log: (level, data, logger, trace) => {
          void Effect.runFork(this.emitLog(connectionScope, level, data, logger, trace));
        },
        namespace: this.telemetryNamespace,
      }),
      ...deriveOps({
        surface: "mcp",
        scope: connectionScope,
        runOperation: this.runOperation.bind(this),
      }),
      progress: () => {
        /* no-op — no progress token before the SDK sees the request */
      },
      task: "auto",
      transport: "mcp" as const,
      tasks: this.serverTasks,
      mcp: {
        serverId: this.scopeId,
        connectionId: `conn:${label}:${ulid()}`,
        transportKind: info.transportKind,
        connectedAt: Date.now(),
        user: null,
        clientInfo: null,
        clientCapabilities: null,
      },
      metadata: omitUndefined({
        ...(info.headers ? { headers: info.headers } : {}),
        origin: info.origin,
        remoteAddress: info.remoteAddress,
      }),
    };
  }

  /**
   * Resolve the `instructions` slot for one connection, projected into the
   * MCP `InitializeResult.instructions` field. A fixed `string` passes
   * through; a `(ctx) => string` is evaluated against a request context
   * carrying the authenticated identity (so instructions can vary per
   * user). Returns `undefined` when no instructions slot was configured.
   * Called once per `acceptConnection` (≈ per `initialize`) — never
   * cached across connections.
   */
  private async resolveInstructions(info: McpConnectionInfo): Promise<string | undefined> {
    const instructions = this.options.instructions;
    if (instructions === undefined) return undefined;
    if (typeof instructions === "string") return instructions;
    const ctx = await this.buildInstructionsContext(info);
    return instructions(ctx);
  }

  /**
   * Build the request context an `instructions` function sees. Resolves
   * identity by running the configured `Authenticator` (mirroring the
   * per-request pipeline's authenticate stage) so `ctx.mcp.user` is
   * populated. Best-effort: an unauthenticated crossing — or an
   * authenticator that throws — still yields a context with
   * `mcp.user: null`, and the instructions function decides how to handle
   * anonymity.
   */
  private async buildInstructionsContext(info: McpConnectionInfo): Promise<McpRequestContext> {
    const base = this.buildOffConnectionContext(info, "init");
    try {
      const authn = await this.security.authenticator(base);
      if (authn.authenticated) {
        return { ...base, mcp: { ...base.mcp, user: authn.user } };
      }
    } catch {
      /* fall through with mcp.user: null */
    }
    return base;
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
