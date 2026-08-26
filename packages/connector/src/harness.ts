/**
 * `ConnectorsHarness` — the gateway's built-in connectors machinery (ADR 104).
 *
 * One harness per gateway, constructed as the gateway's own child: substrate
 * (journal / bus / inbox) flows in positionally (ADR 31) and the gateway's
 * interceptor cascade arrives live (ADR 83 §4), so `gateway.guard()` /
 * `gateway.use()` reach every connector command. Individual connectors are
 * ENTRIES — specs in a map — exactly as tools are entries in the tool
 * executor.
 *
 * Command grammar:
 *
 *   - `connectors:register` / `connectors:unregister` — dynamic membership
 *     (construction-supplied specs go through {@link adopt}, which is
 *     configuration, not an operation).
 *   - `connectors:start` / `connectors:stop` — per-connector source
 *     lifecycle; failures journal individually.
 *   - `connectors:inbound` — the routing hop: normalize messages, open the
 *     ADR 100 `as()` door when the event carries an identity, dispatch the
 *     send / runOnce. Ephemeral delivery and the `stream` hand-off happen
 *     inside this op; the guard seam for allowlists / rate limits.
 *   - `connectors:deliver` — the bus-side outbound hop (turn completed on a
 *     connector-held session) and the host-initiated `handle.deliver` path.
 *
 * `get` / `list` / `status` are plain reads — map lookups, not operations.
 */

import { Effect } from "effect";
import type {
  AppHarnessProtocol,
  ConfirmationPrompt,
  ConfirmationReply,
  ConnectorContext,
  ConnectorHandle,
  ConnectorSpec,
  ConnectorStatus,
  ConnectorsHarnessProtocol,
  ContentBlock,
  EventBus,
  GatewayInstallerHost,
  InboundMessage,
  MessageInbox,
  Operation,
  OperationJournal,
  ProtocolEvent,
  SendMessageInput,
  SendResult,
  SessionHarnessProtocol,
  StreamingTurn,
  Unsubscribe,
} from "@agentick/spec";
import { extractText, HandlerError } from "@agentick/spec";
import type { MessageEnvelope, MessageHandlerError } from "@agentick/spec";
import type { Runtime } from "effect";
import { BaseHarness, forkBusSubscription, type BaseHarnessOptions } from "@agentick/runtime";

import { formatConfirmationMessage, parseTextConfirmation } from "./confirmations.js";
import { textStream } from "./text-stream.js";

const SURFACE = "connectors" as const;

// ADR 80/83 — type the connector verbs on the derived surfaces: hooks
// (`onBeforeConnectorsInbound`, …) and guard-bag keys (`connectorsInbound`,
// …) on the gateway's live cascade. The policy seam of ADR 104 §5.
declare module "@agentick/runtime" {
  interface CommandRegistry {
    "connectors:register": { input: ConnectorSpec; output: void };
    "connectors:unregister": { input: { readonly name: string }; output: void };
    "connectors:start": { input: { readonly connector: string }; output: void };
    "connectors:stop": { input: { readonly connector: string }; output: void };
    "connectors:inbound": {
      input: { readonly connector: string; readonly message: InboundMessage };
      output: void;
    };
    "connectors:deliver": {
      input: {
        readonly connector: string;
        readonly sessionId: string;
        readonly response: string;
        readonly output: readonly ContentBlock[];
      };
      output: void;
    };
  }
}

const ELICITATION_EVENT_NAME = "session:channel:elicitation";
const LOOP_EXECUTION_EVENT_NAME = "loop:command:run-execution";

/**
 * The session's elicitation surface, cast at the call site —
 * `@agentick/connector` deliberately holds no runtime dependency on
 * `@agentick/elicitation` (the AppHarness owns construction, #159). Same
 * discipline as the gateway's `session/respond_to_elicitation` wire method.
 */
type SessionWithElicitation = SessionHarnessProtocol & {
  readonly elicitation: {
    respond(input: {
      readonly correlationId: string;
      readonly outcome: "accepted" | "declined" | "cancelled";
      readonly value?: unknown;
      readonly reason?: string;
    }): Promise<void>;
  };
};

function normalizeMessages(msg: InboundMessage): readonly SendMessageInput[] {
  const base: readonly SendMessageInput[] =
    typeof msg.messages === "string" ? [{ role: "user", content: msg.messages }] : msg.messages;
  if (msg.source === undefined) return base;
  return base.map((m) =>
    (m.metadata as { source?: unknown } | undefined)?.source !== undefined
      ? m
      : { ...m, metadata: { ...m.metadata, source: msg.source } },
  );
}

interface ConnectorEntry {
  readonly spec: ConnectorSpec;
  readonly defaultSessionId: string;
  status: ConnectorStatus;
  error?: Error;
  started: boolean;
  teardown?: () => void | Promise<void>;
  readonly subscriptions: Unsubscribe[];
  readonly managedSessions: Set<string>;
  readonly pendingConfirmations: Map<string, { readonly sessionId: string }>;
  readonly handle: ConnectorHandle;
}

interface InboundInput {
  readonly connector: string;
  readonly message: InboundMessage;
}

interface DeliverInput {
  readonly connector: string;
  readonly sessionId: string;
  readonly response: string;
  readonly output: readonly ContentBlock[];
}

export interface ConnectorsHarnessOptions extends BaseHarnessOptions<unknown, typeof SURFACE> {
  /** The gateway host surface — `apps()`, the ADR 100 `as()` door, metadata. */
  readonly gateway: GatewayInstallerHost;
}

export class ConnectorsHarness
  extends BaseHarness<typeof SURFACE>
  implements ConnectorsHarnessProtocol
{
  private readonly host: GatewayInstallerHost;
  private readonly entries = new Map<string, ConnectorEntry>();
  /** Set by {@link start} / cleared by {@link stop} — `register` auto-starts while true. */
  private running = false;

  private readonly registerCmd: (spec: ConnectorSpec) => Promise<void>;
  private readonly unregisterCmd: (input: { readonly name: string }) => Promise<void>;
  private readonly startCmd: (input: { readonly connector: string }) => Promise<void>;
  private readonly stopCmd: (input: { readonly connector: string }) => Promise<void>;
  private readonly inboundCmd: (input: InboundInput) => Promise<void>;
  private readonly deliverCmd: (input: DeliverInput) => Promise<void>;

  constructor(
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: ConnectorsHarnessOptions,
  ) {
    super(SURFACE, `${options.gateway.gatewayId}:connectors`, journal, bus, inbox, options);
    this.host = options.gateway;

    this.registerCmd = this.command({
      name: "connectors:register",
      exposure: "internal",
      handler: (spec: ConnectorSpec) =>
        Effect.gen(this, function* () {
          this.adopt(spec);
          if (this.running) yield* Effect.promise(() => this.startCmd({ connector: spec.name }));
        }),
    });
    this.unregisterCmd = this.command({
      name: "connectors:unregister",
      exposure: "internal",
      handler: (input: { readonly name: string }) =>
        Effect.tryPromise({
          try: async () => {
            const entry = this.entries.get(input.name);
            if (!entry) return;
            if (entry.started) await this.stopCmd({ connector: input.name });
            this.entries.delete(input.name);
          },
          catch: toError,
        }),
    });
    this.startCmd = this.command({
      name: "connectors:start",
      exposure: "internal",
      handler: (input: { readonly connector: string }) =>
        Effect.gen(this, function* () {
          const entry = this.mustEntry(input.connector);
          if (entry.started) return;
          const runtime = yield* Effect.runtime<never>();
          yield* Effect.tryPromise({
            try: () => this.startEntry(entry, runtime),
            catch: toError,
          });
        }),
    });
    this.stopCmd = this.command({
      name: "connectors:stop",
      exposure: "internal",
      handler: (input: { readonly connector: string }) =>
        Effect.tryPromise({
          try: async () => {
            const entry = this.mustEntry(input.connector);
            if (!entry.started) return;
            entry.started = false;
            for (const unsub of entry.subscriptions.splice(0)) unsub();
            entry.pendingConfirmations.clear();
            const teardown = entry.teardown;
            entry.teardown = undefined;
            if (teardown) await teardown();
            this.setStatus(entry, "disconnected");
          },
          catch: toError,
        }),
    });
    this.inboundCmd = this.command({
      name: "connectors:inbound",
      exposure: "internal",
      handler: (input: InboundInput) =>
        Effect.tryPromise({
          try: () => this.routeInbound(this.mustEntry(input.connector), input.message),
          catch: toError,
        }),
    });
    this.deliverCmd = this.command({
      name: "connectors:deliver",
      exposure: "internal",
      handler: (input: DeliverInput) =>
        Effect.tryPromise({
          try: async () => {
            const entry = this.mustEntry(input.connector);
            if (!entry.spec.deliver) {
              throw new Error(`connector "${input.connector}" is ingress-only (no deliver)`);
            }
            await entry.spec.deliver({
              sessionId: input.sessionId,
              response: input.response,
              output: input.output,
            });
          },
          catch: toError,
        }),
    });

    this.onClose(() => this.stop());
  }

  // ─── Protocol: membership ─────────────────────────────────────────

  /**
   * Construction-path registration — configuration, not an operation
   * (option-supplied specs are gateway config, exactly as `tools:` are).
   * The gateway calls this for `createGateway({ connectors })`; runtime
   * additions go through {@link register}, which journals.
   */
  adopt(spec: ConnectorSpec): void {
    if (!spec || typeof spec.name !== "string" || spec.name.length === 0) {
      throw new Error("connector spec requires a non-empty name");
    }
    if (typeof spec.start !== "function") {
      throw new Error(`connector "${spec.name}": start() is required`);
    }
    if (this.entries.has(spec.name)) {
      throw new Error(`connector "${spec.name}" is already registered`);
    }
    const self = this;
    const entry: ConnectorEntry = {
      spec,
      defaultSessionId: spec.session ?? `connector:${spec.name}`,
      status: "disconnected",
      started: false,
      subscriptions: [],
      managedSessions: new Set(),
      pendingConfirmations: new Map(),
      handle: {
        name: spec.name,
        get status() {
          return self.entries.get(spec.name)?.status ?? "disconnected";
        },
        get error() {
          return self.entries.get(spec.name)?.error;
        },
        deliver: ({ sessionId, response, output }) =>
          self.deliverCmd({
            connector: spec.name,
            sessionId,
            response,
            output: output ?? [{ type: "text", text: response }],
          }),
      },
    };
    this.entries.set(spec.name, entry);
  }

  register(spec: ConnectorSpec): Promise<void> {
    return this.registerCmd(spec);
  }

  unregister(name: string): Promise<void> {
    return this.unregisterCmd({ name });
  }

  // ─── Protocol: reads ──────────────────────────────────────────────

  get(name: string): ConnectorHandle | undefined {
    return this.entries.get(name)?.handle;
  }

  list(): readonly ConnectorHandle[] {
    return Array.from(this.entries.values(), (e) => e.handle);
  }

  status(name: string): ConnectorStatus | undefined {
    return this.entries.get(name)?.status;
  }

  // ─── Protocol: lifecycle ──────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    for (const entry of this.entries.values()) {
      if (!entry.started) await this.startCmd({ connector: entry.spec.name });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const entry of this.entries.values()) {
      if (entry.started) await this.stopCmd({ connector: entry.spec.name });
    }
  }

  // ─── Source lifecycle (inside the `connectors:start` op) ──────────

  private async startEntry(entry: ConnectorEntry, runtime: Runtime.Runtime<never>): Promise<void> {
    const { spec } = entry;
    entry.started = true;
    this.setStatus(entry, "connecting");

    if (spec.deliver) {
      entry.subscriptions.push(
        forkBusSubscription(
          this.bus,
          { surface: "loop", name: { exact: LOOP_EXECUTION_EVENT_NAME }, phase: "terminal" },
          (event) => {
            const sid = event.scope?.sessionId;
            if (!sid || !entry.managedSessions.has(sid)) return;
            const result = extractSendResult(event);
            if (!result || result.output.length === 0) return;
            // `SendResult.response` is assembled by the session-send wrapper
            // and is absent on the raw loop-terminal envelope — derive from
            // `output` (the field that IS present). Failure is the op's
            // record; nothing else to notify.
            const response = result.response ?? extractText(result.output);
            void this.deliverCmd({
              connector: spec.name,
              sessionId: sid,
              response,
              output: result.output,
            }).catch(() => {});
          },
        ),
      );
    }

    if (spec.confirm) {
      const present = spec.confirm.bind(spec);
      entry.subscriptions.push(
        forkBusSubscription(this.bus, { name: { exact: ELICITATION_EVENT_NAME } }, (event) => {
          const sid = event.scope?.sessionId;
          if (!sid || !entry.managedSessions.has(sid)) return;
          // `request()` envelopes carry correlationId in a `metadata`
          // sidecar the base harness stamps at publish time — not on the
          // typed `EventEnvelope`. Observed wire shape.
          const meta = (event as { metadata?: { correlationId?: string; requestType?: string } })
            .metadata;
          if (meta?.requestType !== "request" || !meta.correlationId) return;
          const payload = event.payload as
            | { mode?: "form" | "url"; message?: string; url?: string }
            | undefined;
          if (!payload) return;
          const correlationId = meta.correlationId;
          entry.pendingConfirmations.set(correlationId, { sessionId: sid });
          const prompt: ConfirmationPrompt = {
            sessionId: sid,
            correlationId,
            message: formatConfirmationMessage({
              message: payload.message ?? "Confirm?",
              ...(payload.url ? { url: payload.url } : {}),
            }),
            mode: payload.mode ?? "form",
            ...(payload.url ? { url: payload.url } : {}),
          };
          void Promise.resolve(present(prompt)).catch(() => {});
        }),
      );
    }

    const ctx = this.buildContext(entry, runtime);
    const teardown = await spec.start(ctx);
    if (typeof teardown === "function") entry.teardown = teardown;
    if (entry.status === "connecting") this.setStatus(entry, "connected");
  }

  private buildContext(entry: ConnectorEntry, runtime: Runtime.Runtime<never>): ConnectorContext {
    const { spec } = entry;
    const inbound = (message: InboundMessage): void => {
      // The op journals its own failure; the catch only prevents an
      // unhandled rejection on this fire-and-forget edge.
      void this.inboundCmd({ connector: spec.name, message }).catch(() => {});
    };
    const ctx = {
      inbound,
      writable: (defaults: Partial<InboundMessage> = {}) =>
        new WritableStream<InboundMessage | string>({
          write: (chunk) =>
            this.inboundCmd({
              connector: spec.name,
              message:
                typeof chunk === "string"
                  ? { ...defaults, messages: chunk }
                  : { ...defaults, ...chunk },
            }),
        }),
      confirmed: (reply: ConfirmationReply): void => {
        void this.handleConfirmationReply(entry, reply).catch(() => {});
      },
      status: (status: ConnectorStatus, error?: Error): void => {
        this.setStatus(entry, status, error);
      },
      gateway: this.host,
    };
    this.defineOperationFacets(ctx, {}, runtime, "start", { connector: spec.name });
    return ctx as unknown as ConnectorContext;
  }

  private setStatus(entry: ConnectorEntry, status: ConnectorStatus, error?: Error): void {
    entry.status = status;
    entry.error = status === "error" ? error : undefined;
    void Effect.runFork(
      this.emit({
        name: "connectors:event:status",
        phase: "delta",
        scope: {},
        payload: {
          connector: entry.spec.name,
          status,
          ...(error ? { error: String(error) } : {}),
        },
      }),
    );
  }

  // ─── Routing (inside the `connectors:inbound` op) ─────────────────

  private resolveApp(spec: ConnectorSpec): AppHarnessProtocol {
    const apps = this.host.apps();
    if (spec.app) {
      const app = apps.find((a) => a.id === spec.app);
      if (!app) throw new Error(`connector "${spec.name}": no app "${spec.app}" on the gateway`);
      return app;
    }
    if (apps.length === 0) {
      throw new Error(`connector "${spec.name}": no app available on the gateway`);
    }
    return apps[0]!;
  }

  /**
   * The app door for one inbound event. An authenticated identity routes
   * through the gateway's ADR 100 `as()` seam — authorizer, adopter
   * `onBeforeWire…` hooks, principal stamp, exactly as a transport
   * dispatch — landing on the LOCAL harness; without one, the trusted
   * local pole.
   */
  private resolveDoor(
    spec: ConnectorSpec,
    msg: InboundMessage,
  ): {
    createSession(
      init: Parameters<AppHarnessProtocol["createSession"]>[0],
    ): Promise<SessionHarnessProtocol>;
    runOnce: AppHarnessProtocol["runOnce"];
    getSession(sessionId: string): SessionHarnessProtocol | undefined;
  } {
    const app = this.resolveApp(spec);
    if (msg.identity === undefined) {
      return {
        createSession: (init) => app.createSession(init),
        runOnce: (input) => app.runOnce(input),
        getSession: (sessionId) => app.getSession(sessionId),
      };
    }
    const scoped = this.host.as(msg.identity).app(app.id);
    if (!scoped) {
      throw new Error(`connector "${spec.name}": app "${app.id}" not resolvable through as()`);
    }
    return {
      createSession: (init) => scoped.createSession(init),
      runOnce: (input) => scoped.runOnce(input),
      // The identity door has no session-read verb; create-or-resume
      // covers the identity path.
      getSession: () => undefined,
    };
  }

  private async routeInbound(entry: ConnectorEntry, msg: InboundMessage): Promise<void> {
    const { spec } = entry;
    const messages = normalizeMessages(msg);
    const door = this.resolveDoor(spec, msg);

    if (spec.ephemeral) {
      const { result, sessionId } = await door.runOnce({
        send: { ...msg.send, messages },
        ...(msg.session?.metadata !== undefined ? { metadata: msg.session.metadata } : {}),
      });
      // No held session to watch on the bus — hand the result off inside
      // this op (the delivery is part of handling this inbound). A
      // per-event deliver (the event's reply-to) wins.
      const sink = msg.deliver ?? spec.deliver?.bind(spec);
      if (sink && (result.output.length > 0 || result.data !== undefined)) {
        await sink({
          sessionId,
          response: result.response,
          output: result.output,
          ...(result.data !== undefined ? { data: result.data } : {}),
        });
      }
      return;
    }

    const sessionId = msg.sessionId ?? entry.defaultSessionId;
    const session =
      door.getSession(sessionId) ?? (await door.createSession({ sessionId, ...msg.session }));
    entry.managedSessions.add(session.id);

    // TODO(#302: per-message actor stamping) — interceptIngress will carry
    // the platform actor per message; `msg.identity` covers the
    // session-opening half today.
    const handle = await session.send({
      ...(spec.stream ? { stream: true } : {}),
      ...msg.send,
      messages,
    });

    if (spec.stream) {
      const events = handle.readable();
      const turn: StreamingTurn = {
        sessionId: session.id,
        executionId: handle.executionId,
        origin: msg,
        events,
        text: () => textStream(events),
        result: handle.result,
      };
      void Promise.resolve(spec.stream(turn)).catch(() => {});
    }
  }

  private async handleConfirmationReply(
    entry: ConnectorEntry,
    reply: ConfirmationReply,
  ): Promise<void> {
    const pending = entry.pendingConfirmations.get(reply.correlationId);
    if (!pending) return; // unknown or already resolved
    entry.pendingConfirmations.delete(reply.correlationId);
    const session = this.resolveApp(entry.spec).getSession(pending.sessionId);
    if (!session) return;
    // A text reply ANSWERS a yes/no confirmation: "yes" → accepted(true),
    // "no" → accepted(false). `declined`/`cancelled` model an explicit
    // dismissal, which a text reply is not.
    const decision = parseTextConfirmation(reply.text);
    const elic = session as SessionWithElicitation;
    await elic.elicitation.respond({
      correlationId: reply.correlationId,
      outcome: "accepted",
      value: decision.approved,
      reason: decision.reason,
    });
  }

  /**
   * The `connectors:*` verbs are declared commands — routed by the
   * BaseHarness command registry before this fallthrough. Only unknown
   * types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown connectors message type: ${msg.type}` }));
  }

  private mustEntry(name: string): ConnectorEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`unknown connector "${name}"`);
    return entry;
  }

  protected override spanAttributes(
    op: Operation<unknown, unknown, unknown>,
  ): Readonly<Record<string, unknown>> {
    const base = super.spanAttributes(op);
    const input = op.input as { connector?: string; name?: string } | undefined;
    const connector = input?.connector ?? input?.name;
    return typeof connector === "string"
      ? { ...base, [`${this.telemetryNamespace}.connector.name`]: connector }
      : base;
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function extractSendResult(event: ProtocolEvent): SendResult | undefined {
  const payload = event.payload as
    | { result?: { outcome?: string; result?: SendResult } }
    | undefined;
  const outcome = payload?.result;
  if (!outcome || outcome.outcome !== "succeeded" || !outcome.result) return undefined;
  return outcome.result;
}
