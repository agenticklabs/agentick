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
  deriveContext,
  runHarnessProtocol,
  ulid,
  withCallMiddleware,
  type Unsubscribe,
} from "@agentick/runtime";
import type {
  Derived,
  EventBus,
  EventScope,
  IngressIdentity,
  JournalingPolicy,
  McpAuthenticatedUser,
  McpServerConnectionInfo,
  McpServerHarnessProtocol,
  McpRequestContext,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  ProgressToken,
  Prompts,
  Resources,
} from "@agentick/spec";
import {
  DEFAULT_JOURNALING_POLICY,
  deriveHookNames,
  HandlerError,
  McpServerAuthRejected,
  McpServerClosed,
  parseHookKey,
} from "@agentick/spec";
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
import {
  crossingBody,
  crossingOpName,
  securityStageInterceptors,
  type McpCrossing,
  type McpCrossingInput,
  type RunCrossing,
} from "./projection/crossing.js";
import { allowAllAuth, resolveSecurity, type ResolvedSecurity } from "./security/index.js";
import { evaluateConnectionGuard, isMcpSecurityError } from "./security/pipeline.js";
import type { McpConnectionInfo } from "./security/stages.js";
import type { AuthPreGate, ServerTransport } from "./transports/types.js";
import { isFalsey, isNull, omitUndefined } from "@agentick/utils";

const SURFACE = "mcpServer" as const;
type McpServerSurface = typeof SURFACE;

/**
 * Discrete bus event published when an inbound crossing is REJECTED at
 * admission (ADR 92 §Family 1.3). Not an operation — admission denied means no
 * work unit exists — but the audit trail must still see the attempt.
 *
 * Payload carries the connection shape (transport kind, origin, remote address)
 * and a failure CLASS; it never carries credential material. The
 * credentials-never-cross-the-wire law extends to the journal.
 */
export const MCP_SERVER_ADMISSION_FAILED = "mcpServer:admission:failed";

/** How an inbound crossing failed admission. */
export type McpAdmissionFailureClass =
  /** The HTTP auth pre-gate rejected the request (RFC 9728 401 challenge). */
  | "pre-gate"
  /** The per-request `Authenticator` stage rejected the crossing. */
  | "authenticate"
  /** The `ConnectionGuard` refused the connection outright. */
  | "connection-guard";

/**
 * Per-op-class journaling policy for the MCP server (ADR 92 §"Journaling policy
 * is orthogonal to the envelope"). Every crossing gets the ENVELOPE — name,
 * guards, hooks, span — regardless; this decides only what the JOURNAL retains.
 *
 * `call-tool` and `initialize` are state-affecting / session-establishing and
 * persist. Reads, lists, completions and subscription bookkeeping are chatty
 * under a polling client, so they stay bus-only: subscribers, OTel exporters
 * and live debuggers still observe every phase; the durable journal does not
 * grow without bound.
 */
const MCP_SERVER_JOURNALING_POLICY: JournalingPolicy = {
  ...DEFAULT_JOURNALING_POLICY,
  override: {
    [crossingOpName("list-tools")]: "bus-only",
    [crossingOpName("list-resources")]: "bus-only",
    [crossingOpName("list-resource-templates")]: "bus-only",
    [crossingOpName("read-resource")]: "bus-only",
    [crossingOpName("subscribe-resource")]: "bus-only",
    [crossingOpName("unsubscribe-resource")]: "bus-only",
    [crossingOpName("list-prompts")]: "bus-only",
    [crossingOpName("get-prompt")]: "bus-only",
    [crossingOpName("complete")]: "bus-only",
  },
};

/**
 * Project an authenticated MCP user onto the trunk's structured ingress
 * identity (ADR 34/51). `principal` is the scalar identity-scope key; `user` is
 * the adopter-shaped record; `scopes` are the credential's grants. Identifiers
 * and scopes only — never the credential itself.
 */
function toIngressIdentity(
  user: McpAuthenticatedUser | null | undefined,
): IngressIdentity | undefined {
  if (user === null || user === undefined) return undefined;
  return omitUndefined({
    principal: user.id,
    user: { ...user } as Readonly<Record<string, unknown>>,
    scopes: user.scopes,
  });
}

/**
 * Reduce an admission rejection to a short, non-sensitive reason string. A
 * stage's own `reason` is adopter-authored prose; a thrown error contributes
 * only its message. Never the credential — see
 * {@link McpServerHarness.emitAdmissionFailure}.
 */
function normalizeAdmissionReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

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
    // ADR 92 §Slice A — per-op-class journal policy for the crossing ops. The
    // envelope is unconditional; only retention is policy.
    super(SURFACE, scopeId, journal, bus, inbox, { policy: MCP_SERVER_JOURNALING_POLICY });
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
   *
   * ADR 92 §Slice A — the ConnectionGuard stays PRE-OP (a refused connection
   * is admission, not work; its refusal surfaces as an admission-failure
   * event), and everything after it runs as the `mcp:command:initialize`
   * crossing operation: journaled (persisted per policy), guardable, and the
   * span parent of every per-connection projection install.
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
      this.emitAdmissionFailure("connection-guard", info, err);
      try {
        await transport.close();
      } catch {
        /* swallow */
      }
      if (!isMcpSecurityError(err)) throw err;
      return;
    }

    const connectionId = `conn:${ulid()}`;
    const identity = toIngressIdentity(info.authenticatedUser);
    const scope: EventScope = omitUndefined({
      mcpServerId: this.scopeId,
      mcpConnectionId: connectionId,
      identity,
      // An external client through the projection boundary (ADR 51).
      origin: "wire" as const,
    });
    const op: Operation<McpCrossingInput, void, unknown> = {
      opId: `${crossingOpName("initialize")}:${ulid()}`,
      surface: SURFACE,
      name: crossingOpName("initialize"),
      scope,
      input: {
        params: omitUndefined({
          transportKind: info.transportKind,
          origin: info.origin,
          remoteAddress: info.remoteAddress,
        }),
        toolInput: undefined,
      },
    };
    // `runHarnessProtocol` (not a bare `Effect.runPromise`) so a rejection
    // surfaces as the ORIGINAL error value rather than a wrapping FiberFailure
    // — accept-path error semantics are unchanged by the envelope.
    await runHarnessProtocol(
      this.runOperation(op, () =>
        Effect.tryPromise({
          try: () => this.acceptConnectionBody(transport, info, connectionId),
          catch: (cause) => cause,
        }),
      ),
    );
  }

  /**
   * The `mcp:command:initialize` op body — everything downstream of connection
   * admission. Split out so {@link acceptConnection} reads as
   * "admit, then run the crossing".
   */
  private async acceptConnectionBody(
    transport: Transport,
    info: McpConnectionInfo,
    connectionId: string,
  ): Promise<void> {
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

    /**
     * Mint the per-request branded ctx. `overrides` carry what only the
     * crossing knows: the identity the PRE-OP authenticator resolved (ADR 92 —
     * admission stays pre-op) and `tools/call`'s per-call progress token. Both
     * compose INTO the single branded mint rather than being spread on
     * afterwards (a post-mint spread erases the brand and forces the lazy
     * facets).
     */
    const buildRequestContext = (overrides?: {
      readonly user?: McpAuthenticatedUser | null;
      readonly identity?: IngressIdentity;
      readonly progressToken?: ProgressToken;
    }): Derived<McpRequestContext> => {
      // The crossing's trunk: the connection dimensions plus the authenticated
      // ingress identity. This is what a handler reads as `ctx.identity` and
      // what every ad-hoc `ctx.run` op inherits as its scope.
      const requestScope: EventScope = omitUndefined({
        ...connectionScope,
        identity: overrides?.identity,
        origin: "wire" as const,
      });
      // Pull the client's negotiated capabilities + identity from the
      // SDK Server post-initialize. Undefined before initialize
      // completes (which it always has by the time any request handler
      // runs, since the SDK gates requests behind initialize).
      const sdkClientCaps =
        (sdkServer.getClientCapabilities?.() as Readonly<Record<string, unknown>> | undefined) ??
        null;
      const sdkClientInfo = sdkServer.getClientVersion?.() ?? null;
      const clientRoots = clientRootsIngest.current();

      // Attach `elicit` sugar when wired AND the client advertised the
      // capability. Computed BEFORE the mint so it composes as a branded extra
      // (a post-mint `{ ...ctx, elicit }` would erase the brand + force the
      // lazy facets). Tool handlers check for presence — the slot is optional.
      let elicitExtra: ReturnType<typeof buildMcpElicit> | undefined;
      if (this.elicitWired) {
        const elicit = buildMcpElicit({ sdkServer, clientCapabilities: sdkClientCaps });
        if (elicit.canDoForm() || elicit.canDoUrl()) elicitExtra = elicit;
      }

      // ADR 43 / 91 — unified ToolHandlerCtx with `transport: "mcp"` +
      // MCP-specific extras nested under `mcp:`. Minted in ONE branded
      // `deriveContext` call (ADR 91 §Phase-2): the facets attach as lazy
      // getters, every boundary field composes IN as a branded descriptor. No
      // post-derivation spread (which erases the brand AND forces the lazy
      // facets). The trunk derives from the CROSSING (`requestScope` — the
      // connection dims plus the authenticated identity). The facets are
      // RE-ATTACHED in-fiber once the crossing op is running (see
      // `runCrossing`), which is what makes `ctx.run` a CHILD of the crossing
      // rather than an orphaned root. `log` emits ONE bus event scoped to this
      // connection (`installLogProjection` forwards it to
      // `notifications/message`); `trace`/`metrics` go to the telemetry
      // provider, off-path until the in-fiber re-attach.
      const built = deriveContext(
        requestScope,
        {
          log: (level, data, logger, trace) => {
            void Effect.runFork(this.emitLog(connectionScope, level, data, logger, trace));
          },
          namespace: this.telemetryNamespace,
          // The harness's own surface, so a `ctx.run` op is named the same
          // (`mcpServer:run:<name>`) whether it fires before the crossing op
          // starts or from inside it after the in-fiber facet re-attach.
          surface: SURFACE,
          scope: requestScope,
          runOperation: this.runOperation.bind(this),
        },
        {
          // Universal ToolHandlerCtx fields. The MCP server has no `toolCallId`
          // until the tool-call handler runs (the tools projection overwrites
          // this default per-call); `task` defaults to `"auto"` until per-call
          // wire metadata flips it.
          toolCallId: `mcp:req:${ulid()}`,
          signal: new AbortController().signal,
          setState: () => {
            /* no-op for MCP-server ctx — sessions own this */
          },
          emit: () => {
            /* no-op for MCP-server ctx — sessions own channel emit */
          },
          progress: (
            token: ProgressToken,
            p: { progress: number; total?: number; message?: string },
          ): void => {
            void Effect.runFork(
              this.emitProgress(connectionScope, {
                token,
                progress: p.progress,
                ...(p.total !== undefined ? { total: p.total } : {}),
                ...(p.message !== undefined ? { message: p.message } : {}),
              }),
            );
          },
          task: "auto" as const,
          transport: "mcp" as const,
          // #171d.3 — the server's TasksHarness. Handlers calling
          // `ctx.tasks!.submit(...)` get a TaskHandle the tools projection
          // recognises (via isTaskHandle) and routes to the per-connection task
          // registry → CreateTaskResult + notifications/tasks/status.
          tasks: this.serverTasks,
          mcp: {
            serverId: this.scopeId,
            connectionId,
            transportKind: info.transportKind,
            connectedAt,
            user: overrides?.user ?? null,
            clientInfo: sdkClientInfo
              ? { name: sdkClientInfo.name, version: sdkClientInfo.version }
              : null,
            clientCapabilities: sdkClientCaps,
            // ADR 64 / A1 — the client's per-call `_meta.progressToken`, so a
            // handler calling `ctx.progress(ctx.mcp!.progressToken!, …)` emits a
            // signal the progress projection echoes back under the token the
            // client generated. Only `tools/call` carries one.
            ...(overrides?.progressToken !== undefined
              ? { progressToken: overrides.progressToken }
              : {}),
            // ADR 65 — inbound roots, read fresh per request so a
            // `roots/list_changed` re-pull is reflected on the next call.
            // Omitted when the client never advertised `roots`.
            ...(clientRoots !== undefined ? { clientRoots } : {}),
          },
          metadata: omitUndefined({
            ...(info.headers ? { headers: info.headers } : {}),
            origin: info.origin,
            remoteAddress: info.remoteAddress,
          }),
          ...(elicitExtra !== undefined ? { elicit: elicitExtra } : {}),
        },
      );
      const ctx: Derived<McpRequestContext> = built;
      return ctx;
    };

    /**
     * The crossing runner for THIS connection (ADR 92 §Slice A). Every SDK
     * request handler on this connection routes through it:
     *
     *   1. **Authenticate — PRE-OP.** Admission is not an operation (ADR 92
     *      non-goals); a rejected crossing has no work unit, so it produces an
     *      admission-failure EVENT and the same `McpServerAuthRejected` the
     *      pipeline threw before.
     *   2. **Manufacture the op.** `mcp:command:<verb>`, scope = connection
     *      dims + the resolved identity + `origin: "wire"`.
     *   3. **Guard seam.** Authorizer / RateLimiter / InputSanitizer ride the
     *      op's tier-4 call-scoped interceptor list, self-scoped to this
     *      crossing's command so they never touch nested ops.
     *   4. **Re-attach the ctx facets IN-FIBER** with the op runtime + the op's
     *      trunk coordinates, so `ctx.log`/`ctx.trace` nest under the crossing
     *      span and `ctx.run` mints CHILD ops carrying `parentOpId` + the
     *      connection dim.
     *   5. **Body.** The SDK handler, over the post-cascade input.
     */
    const runCrossing: RunCrossing = async <R>(crossing: McpCrossing<R>): Promise<R> => {
      // The ADMISSION ctx — deliberately identity-less. The authenticator is
      // what ESTABLISHES the identity, so it must not be handed one; it reads
      // the credential material off `ctx.metadata.headers`.
      const admissionCtx = buildRequestContext();
      const authn = await this.security.authenticator(admissionCtx);
      if (!authn.authenticated) {
        this.emitAdmissionFailure("authenticate", info, authn.reason, connectionId);
        throw new McpServerAuthRejected({ reason: authn.reason || "Authentication failed" });
      }
      // The CROSSING ctx — the same connection, now carrying the identity
      // admission resolved. Minted (not spread over the admission ctx) so the
      // whole composition stays branded and the lazy facets stay lazy.
      const identity = toIngressIdentity(authn.user);
      const ctx = buildRequestContext(
        omitUndefined({ user: authn.user, identity, progressToken: crossing.progressToken }),
      );

      const opName = crossingOpName(crossing.verb);
      const scope: EventScope = omitUndefined({
        ...connectionScope,
        identity,
        origin: "wire" as const,
      });
      const op: Operation<McpCrossingInput, R, unknown> = {
        opId: `${opName}:${ulid()}`,
        surface: SURFACE,
        name: opName,
        scope,
        input: {
          params: crossing.params ?? {},
          toolInput: crossing.toolInput ? { ...crossing.toolInput } : undefined,
        },
      };
      // The command tag `runOperation` stamps on `ctx.op` — the value each
      // security stage compares against so it fires on the crossing only.
      const command = parseHookKey(deriveHookNames(opName)[0])?.command as string;
      const interceptors = securityStageInterceptors({
        security: this.security,
        ctx,
        operation: crossing.operation,
        command,
      });

      const body = crossingBody(crossing.run, ctx);
      const opEffect = this.runOperation(op, (input) =>
        Effect.gen(this, function* () {
          // ADR 64/78/91 — bind the ctx to the RUNNING op: the captured runtime
          // parents `ctx.trace` spans and makes `ctx.run` a child op, and the
          // op's trunk coordinates (opId as the child's parentOpId) land on the
          // ctx the handler reads.
          const runtime = yield* Effect.runtime<never>();
          this.defineOperationFacets(ctx, scope, runtime, command);
          // The crossing is a ROOT op (it is driven from the SDK's own
          // callback, outside any fiber), so there is no parentOpId to stamp —
          // only its own opId, which the handler reads and its `ctx.run`
          // children inherit as THEIR parent.
          Object.assign(ctx, { opId: op.opId });
          return yield* body(input);
        }),
      );
      // `runHarnessProtocol` unwraps the Exit so a rejected stage throws its
      // ORIGINAL `McpServerError` — the SDK serializer sees the same value it
      // saw pre-envelope, which is what keeps the wire byte-identical.
      return runHarnessProtocol(withCallMiddleware(interceptors, opEffect));
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
        runCrossing,
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
        runCrossing,
      });
      cleanup.push(unsubscribe);
    }

    if (this.resourcesSource !== null) {
      const unsubscribe = installResourcesHandlers(sdkServer, {
        source: this.resourcesSource,
        ...(this.resourcesFilter ? { filter: this.resourcesFilter } : {}),
        runCrossing,
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
        runCrossing,
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
      // ADR 91 §Phase-2 — return the authenticated identity, not just a
      // boolean, so the transport forward-derives it onto the accept path's
      // `McpConnectionInfo` and instructions resolution needn't re-authenticate.
      verify: async (info) => {
        const result = await this.security.authenticator(this.buildPreGateContext(info));
        if (result.authenticated) return { ok: true, user: result.user };
        // ADR 92 §Family 1.3 — a 401'd crossing leaves a trace. The pre-gate is
        // the LAST place holding the connection shape before the transport
        // writes the challenge and drops the request.
        this.emitAdmissionFailure("pre-gate", info, result.reason);
        return { ok: false };
      },
    };
  }

  /**
   * Minimal `McpRequestContext` for the HTTP auth pre-gate. Built
   * OFF-connection (no SDK Server / session exists yet — the pre-gate
   * runs before the crossing is handed to the SDK), carrying only the
   * identity material an `Authenticator` reads.
   */
  private buildPreGateContext(info: McpConnectionInfo): Derived<McpRequestContext> {
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
  ): Derived<McpRequestContext> {
    const connectionScope: Partial<EventScope> = { mcpServerId: this.scopeId };
    // ADR 91 §Phase-2 — mint branded in ONE `deriveContext` call (no
    // brand-erasing / facet-forcing spread). Off-fiber crossing: `ctx.run` ops
    // run as roots. `mcp.user` seeds from `info.authenticatedUser` when the
    // HTTP pre-gate already authenticated this crossing and FORWARD-DERIVED its
    // identity onto `info` (ADR 91 §Phase-2 single-authenticator) — else
    // explicit anonymous identity (`null`).
    const built = deriveContext(
      connectionScope,
      {
        log: (level, data, logger, trace) => {
          void Effect.runFork(this.emitLog(connectionScope, level, data, logger, trace));
        },
        namespace: this.telemetryNamespace,
        surface: SURFACE,
        scope: connectionScope,
        runOperation: this.runOperation.bind(this),
      },
      {
        toolCallId: `mcp:${label}:${ulid()}`,
        signal: new AbortController().signal,
        setState: () => {
          /* no-op — no session behind an off-connection crossing */
        },
        emit: () => {
          /* no-op — no channel behind an off-connection crossing */
        },
        progress: () => {
          /* no-op — no progress token before the SDK sees the request */
        },
        task: "auto" as const,
        transport: "mcp" as const,
        tasks: this.serverTasks,
        mcp: {
          serverId: this.scopeId,
          connectionId: `conn:${label}:${ulid()}`,
          transportKind: info.transportKind,
          connectedAt: Date.now(),
          user: info.authenticatedUser ?? null,
          clientInfo: null,
          clientCapabilities: null,
        },
        metadata: omitUndefined({
          ...(info.headers ? { headers: info.headers } : {}),
          origin: info.origin,
          remoteAddress: info.remoteAddress,
        }),
      },
    );
    const ctx: Derived<McpRequestContext> = built;
    return ctx;
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
   *
   * ADR 91 §Phase-2 single-authenticator (forward-derivation): when the HTTP
   * pre-gate already authenticated this crossing it stamps the identity onto
   * `info.authenticatedUser`, which {@link buildOffConnectionContext} seeds
   * into `ctx.mcp.user` — so this DOES NOT run the authenticator again (the
   * redundant instructions-time run is retired; the per-operation authenticate
   * stage still runs downstream, defense in depth). Only a crossing that was
   * NOT pre-gated (trusted transport / no OAuth ⇒ `authenticatedUser` absent)
   * falls back to a best-effort authenticator run here, so stdio / in-memory
   * instructions keep their prior identity behavior.
   */
  private async buildInstructionsContext(
    info: McpConnectionInfo,
  ): Promise<Derived<McpRequestContext>> {
    // Fast path: the pre-gate forward-derived an identity (or explicit anon) —
    // a single branded mint, no second authenticator run.
    if (info.authenticatedUser !== undefined) {
      return this.buildOffConnectionContext(info, "init");
    }
    // No pre-gate ran (trusted transport / no OAuth): resolve identity here,
    // best-effort, then mint once with it seeded via `authenticatedUser`.
    let user: McpAuthenticatedUser | null = null;
    try {
      const authn = await this.security.authenticator(this.buildOffConnectionContext(info, "init"));
      if (authn.authenticated) user = authn.user;
    } catch {
      /* fall through with mcp.user: null */
    }
    return this.buildOffConnectionContext({ ...info, authenticatedUser: user }, "init");
  }

  // ─────────── Internal — used by transport + projection layers (#171c+) ───────────

  /**
   * Publish the admission-failure event for a REJECTED inbound crossing
   * (ADR 92 §Family 1.3). A discrete event, not an operation: admission denied
   * means no work unit exists, so there is no phase contract to run — but the
   * audit trail must still see the attempt so probing shows up.
   *
   * Carries the connection SHAPE (transport kind, origin, remote address) plus
   * the failure class and the stage's own reason string. It never carries the
   * credential, the `Authorization` header, or any other request headers — the
   * credentials-never-cross-the-wire law extends to the journal.
   */
  private emitAdmissionFailure(
    failureClass: McpAdmissionFailureClass,
    info: McpConnectionInfo,
    reason?: unknown,
    connectionId?: string,
  ): void {
    const scope: EventScope = omitUndefined({
      mcpServerId: this.scopeId,
      mcpConnectionId: connectionId,
      origin: "wire" as const,
    });
    void Effect.runFork(
      this.emit({
        name: MCP_SERVER_ADMISSION_FAILED,
        phase: "terminal",
        outcome: "failed",
        scope,
        payload: omitUndefined({
          failureClass,
          transportKind: info.transportKind,
          origin: info.origin,
          remoteAddress: info.remoteAddress,
          reason: normalizeAdmissionReason(reason),
        }),
      }),
    );
  }

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
