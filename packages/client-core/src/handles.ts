/**
 * Resource handles — typed views of gateway / app / session served by
 * a `ClientProtocol`.
 *
 * Handles are thin proxies: they forward method calls to
 * `client.request(method, params)` and `client.transport.subscribe(...)`,
 * with type-narrowed surfaces.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"The developer surface"
 */

import type {
  AppHandle,
  AppModelInfoResult,
  SessionModelInfoResult,
  ChannelView,
  ChannelViewConfig,
  ClientProtocol,
  ClientSessionExecutionHandle,
  ClientSendInput,
  ClientTransport,
  ContentBlock,
  CreateSessionInput,
  EventQuery,
  ProgressEventPayload,
  GatewayHandle,
  GatewayListAppsResult,
  HandleSubscriptions,
  SendInput,
  SendMessageInput,
  SessionEntry,
  SessionFilter,
  SessionHandle,
  SessionHandleBase,
  SessionPageRequest,
  StreamEvent,
  SubscriptionScope,
  SubscriptionStream,
  WireMethod,
} from "@agentick/spec";
import type { Cursor } from "@agentick/spec";
import { isProgressEventName } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";
import { onLog as onLogFn, onProgress as onProgressFn } from "./signals.js";
import { channelView as channelViewFn } from "./channel-view.js";
import { sessionStatusView, type SessionStatusView } from "./session-status-view.js";
import {
  applySessionHandleExtensions,
  knownSessionHandleExtensionImports,
  SessionSubHandleNotRegistered,
  type SessionSubHandleTeardown,
} from "./session-handle-extensions.js";
import { makeWireNamespace } from "./wire-namespace.js";

interface InternalClient {
  readonly id: string;
  request: ClientProtocol["request"];
  /** Present on a real client (B2 slice 4 §7); absent on bare test doubles, where
   *  per-handle `use` degrades to an inert no-op. */
  use?: ClientProtocol["use"];
  readonly transport: ClientProtocol["transport"];
}

/**
 * Build the {@link HandleSubscriptions} surface pre-scoped to `scope` —
 * each method bakes the handle's scope into the corresponding free
 * function, so callers write `handle.onLog(cb)` instead of
 * `onLog(client, scope, cb)`. Shared by all three make*Handle factories.
 */
function scopedSubscriptions(
  client: InternalClient,
  scope: SubscriptionScope,
): HandleSubscriptions {
  function channelView<T, F>(channel: string, config: ChannelViewConfig<T, F>): ChannelView<T>;
  function channelView<T = unknown>(channel: string): ChannelView<T | undefined>;
  function channelView(
    channel: string,
    config?: ChannelViewConfig<unknown, unknown>,
  ): ChannelView<unknown> {
    return config === undefined
      ? channelViewFn(client, scope, channel)
      : channelViewFn(client, scope, channel, config);
  }
  return {
    onLog: (handler, opts) => onLogFn(client, scope, handler, opts),
    onProgress: (handler, opts) => onProgressFn(client, scope, handler, opts),
    channelView,
  };
}

export function makeGatewayHandle(client: InternalClient): GatewayHandle {
  return {
    ...scopedSubscriptions(client, { kind: "gateway" }),
    async listApps(): Promise<GatewayListAppsResult> {
      return client.request("gateway/list_apps", {});
    },
    async getApp(id) {
      return client.request("gateway/get_app", { appId: id });
    },
    async destroySession(sessionId, opts) {
      releaseSessionHandle(client, sessionId);
      return client.request("gateway/destroy_session", {
        sessionId,
        reason: opts?.reason,
      });
    },
    async listSessions(filter, page) {
      return client.request("gateway/list_sessions", {
        filter,
        cursor: page?.cursor,
        limit: page?.limit,
      });
    },
    events(query, fromCursor) {
      return client.transport.subscribe({ kind: "gateway" }, query, fromCursor);
    },
    app(id: string): AppHandle {
      return makeAppHandle(client, id);
    },
  };
}

export function makeAppHandle(client: InternalClient, appId: string): AppHandle {
  return {
    ...scopedSubscriptions(client, { kind: "app", id: appId }),
    id: appId,
    async createSession<P = unknown>(input?: CreateSessionInput<P>) {
      return client.request("app/create_session", {
        appId,
        sessionId: input?.sessionId,
        metadata: input?.metadata,
        eager: input?.eager,
      });
    },
    async getSession(sessionId): Promise<SessionEntry> {
      return client.request("app/get_session", { appId, sessionId }) as Promise<SessionEntry>;
    },
    modelInfo(provider: string, modelId: string) {
      return client.request("app/model_info", {
        appId,
        provider,
        modelId,
      }) as Promise<AppModelInfoResult>;
    },
    async listSessions(filter?: SessionFilter, page?: SessionPageRequest) {
      return client.request("app/list_sessions", {
        appId,
        filter,
        cursor: page?.cursor,
        limit: page?.limit,
      });
    },
    // Hand-written like every other `app/*` verb on this handle. The wire-row
    // DERIVATION (`makeWireNamespace`) synthesizes namespace methods for the
    // SESSION handle only — an app-namespace verb takes `appId` from the handle
    // rather than a `sessionId` from the caller, which is not a shape that
    // derivation covers. Extending it to the app namespace is a separate change
    // to the derivation, not a rider on this verb.
    async destroySession(sessionId, opts) {
      releaseSessionHandle(client, sessionId);
      return client.request("app/destroy_session", {
        appId,
        sessionId,
        reason: opts?.reason,
      });
    },
    async runOnce<P = unknown>(input: SendInput<P>) {
      return client.request("app/run_once", {
        appId,
        messages: input.messages as readonly SendMessageInput[] | undefined,
        props: input.props,
        metadata: input.metadata,
        maxTicks: input.maxTicks,
        stream: input.stream,
        target: input.target,
      });
    },
    async close() {
      await client.request("app/close", { appId });
    },
    events(query, fromCursor) {
      return client.transport.subscribe({ kind: "app", id: appId }, query, fromCursor);
    },
    session(sessionId: string): SessionHandle {
      return makeSessionHandle(client, sessionId);
    },
  };
}

/**
 * The open session handles per client, keyed by session id, each with the
 * teardown for what it opened. A handle owns subscriptions — the tool-call fold,
 * the status view, every ADR-87 sub-handle — so handing out a second one for the
 * same session opens a second copy of each, and whichever half of the app holds
 * the other instance never sees the frames.
 *
 * Every way a session ENDS evicts: `close()` here, and `destroySession` from the
 * app or gateway door via {@link releaseSessionHandle}. A handle left in this map
 * after its session is gone would be handed to the next caller asking for that
 * id, holding subscriptions to a session the server has already forgotten.
 */
const openSessionHandles = new WeakMap<
  InternalClient,
  Map<string, { readonly handle: SessionHandle; readonly release: () => readonly unknown[] }>
>();

/**
 * Release the client-side handle for a session that ended from a door other than
 * `session.close()` — `app.destroySession` / `gateway.destroySession`. Closes
 * what the handle opened WITHOUT sending `session/close`: the session is already
 * being destroyed, and a second verb chasing it is a race, not a cleanup.
 */
function releaseSessionHandle(client: InternalClient, sessionId: string): void {
  const entry = openSessionHandles.get(client)?.get(sessionId);
  if (entry === undefined) return;
  openSessionHandles.get(client)!.delete(sessionId);
  entry.release();
}

export function makeSessionHandle(client: InternalClient, sessionId: string): SessionHandle {
  const open =
    openSessionHandles.get(client) ??
    new Map<string, { handle: SessionHandle; release: () => readonly unknown[] }>();
  openSessionHandles.set(client, open);
  const memoized = open.get(sessionId);
  if (memoized !== undefined) return memoized.handle;
  // Assigned right below the literal, once the sub-handle getters are installed;
  // `close()` reaches it through the closure rather than through `this`.
  let closeSubHandles: SessionSubHandleTeardown;
  // Declared BEFORE the handle literal because the `status` getter builds
  // against it. See the comment at `applySessionHandleExtensions` below for why
  // sub-handle factories get this view of the client rather than the raw one.
  const handleClient = withMiddlewareTransport(client);
  let statusView: SessionStatusView | undefined;
  /** Everything this handle opened, released together. Returns the failures. */
  const release = (): readonly unknown[] => {
    statusView?.close();
    return closeSubHandles();
  };
  // Typed against the hand-written BASE ({@link SessionHandleBase}) so the literal
  // is fully checked. The registered sub-handles (`session.knobs`, …) are attached
  // as getters below (ADR 87); the wire-DERIVED namespace methods
  // (`session.billing.approve`, …) are synthesized by the Proxy wrapper at return.
  // The full `SessionHandle` (base ∧ sub-handles ∧ wire namespaces) is reached by
  // CASTING the Proxy — never by widening.
  const handle: SessionHandleBase = {
    ...scopedSubscriptions(client, { kind: "session", id: sessionId }),
    id: sessionId,
    // Built on FIRST ACCESS, not at handle construction: `app.session(id)` is a
    // cheap addressing call and must not open a wire subscription per call.
    get status(): SessionStatusView {
      return (statusView ??= sessionStatusView(handleClient, sessionId));
    },
    send<P = unknown>(input: ClientSendInput<P>): ClientSessionExecutionHandle {
      return createSessionExecutionHandle(client, sessionId, input);
    },
    modelInfo() {
      return client.request("session/model_info", {
        sessionId,
      }) as Promise<SessionModelInfoResult>;
    },
    async dispatch(tool, input): Promise<readonly ContentBlock[]> {
      const result = await client.request("session/dispatch", {
        sessionId,
        tool,
        input,
      });
      return result.content;
    },
    async abort(reason, opts) {
      // `cascade` rides the same verb — see `SessionAbortOptions`. Omitted when
      // not asked for, so the request body is byte-identical to the old one.
      await client.request("session/abort", {
        sessionId,
        reason,
        ...(opts?.cascade !== undefined ? { cascade: opts.cascade } : {}),
      });
    },
    async snapshot(): Promise<unknown> {
      const result = await client.request("session/snapshot", { sessionId });
      return result.snapshot;
    },
    async dryRun() {
      return client.request("session/dry_run", { sessionId });
    },
    async compile(): Promise<unknown> {
      const result = await client.request("session/compile", { sessionId });
      return result.tree;
    },
    async project(): Promise<unknown> {
      const result = await client.request("session/project", { sessionId });
      return result.input;
    },
    async rebind(auth) {
      await client.request("session/rebind", { sessionId, auth });
    },
    /**
     * Close the session AND release what this handle opened. Every BUILT
     * sub-handle (`session.knobs`, `session.timeline`, … — each one holding a
     * live wire subscription) is closed first, then the `session/close` RPC
     * goes out. Without the first half the server-side session ends while the
     * client keeps every channel subscription and live stream running.
     *
     * Best-effort and order-independent: a sub-handle whose `close()` throws
     * does NOT stop the others or suppress the RPC; the failures surface
     * together as an `AggregateError` once the session is closed. Sub-handles
     * that were never touched are never built — closing a session does not open
     * the subscriptions it is about to abandon. Idempotent, because the teardown
     * runs once and every sub-handle `close()` is itself idempotent.
     */
    async close() {
      open.delete(sessionId);
      const failures = release();
      await client.request("session/close", { sessionId });
      if (failures.length > 0) {
        throw new AggregateError(failures, "session.close(): sub-handle teardown failed");
      }
    },
    events(query?: EventQuery, fromCursor?: Cursor): SubscriptionStream {
      return client.transport.subscribe({ kind: "session", id: sessionId }, query, fromCursor);
    },
    treeEvents(query?: EventQuery, fromCursor?: Cursor): SubscriptionStream {
      return client.transport.subscribe({ kind: "session-tree", id: sessionId }, query, fromCursor);
    },
  };
  // ADR 87 — spread registered per-harness sub-handles (session.tasks, .knobs, …)
  // as lazy getters. Client-core stays agnostic; harness /client packages register.
  // The factories receive a client whose `transport.request` funnels through the
  // client MIDDLEWARE chain (B2 slice 4 §7), so a sub-handle's write verbs
  // (`knobs.set`, `elicitations.respond`, …) are covered by `client.use(...)`
  // WITHOUT each handle rewiring its transport — the derived-from-wire rule made
  // universal. `transport.subscribe`/`progress` pass through untouched (a fold's
  // input is a stream, not a call — it gets a frame tap, not middleware).
  closeSubHandles = applySessionHandleExtensions(handle, handleClient, sessionId);
  // B2 slice 4 — WIRE PROXY: wrap so an unregistered namespace access
  // (`session.billing`) synthesizes a namespace whose methods issue
  // `client.request("billing/<method>", { sessionId, ...params })`. Registered
  // sub-handles and base members are served from `handle` untouched; only
  // unknown namespaces fall through to synthesis. Cast to the mapped
  // `SessionHandle` — the runtime is a superset, the type is the guard.
  const wrapped = wrapSessionWireProxy(handle, client, sessionId);
  open.set(sessionId, { handle: wrapped, release });
  return wrapped;
}

/**
 * A view of the client whose `transport.request` funnels through the client's
 * middleware chain (`client.request`), while every other transport member
 * (`subscribe`, `progress`, `state`, …) and every other client member (`use`,
 * `request`, …) pass through untouched. Handed to ADR-87 sub-handle factories so
 * their write verbs pick up `client.use(...)` for free.
 */
function withMiddlewareTransport(client: InternalClient): ClientProtocol {
  const middlewareTransport = new Proxy(client.transport, {
    get(target, prop, receiver) {
      if (prop === "request") {
        return (method: WireMethod, params: unknown, signal?: AbortSignal) =>
          client.request(method, params as never, signal);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as ClientTransport;

  return new Proxy(client as unknown as ClientProtocol, {
    get(target, prop, receiver) {
      if (prop === "transport") return middlewareTransport;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * Wrap the base session handle so property access on an UNREGISTERED wire
 * namespace (`session.billing`) returns a synthesized namespace proxy. Base
 * members and ADR-87 sub-handle getters (already `in handle`) are served
 * untouched — a REGISTERED namespace reaches its leftover wire rows through its
 * own `wireFallthrough` wrapper one level down, installed by
 * `applySessionHandleExtensions`, not here; symbols and `then` never synthesize
 * (so the handle is not a
 * thenable and structured-clone / inspection don't trip the trap). Namespace
 * proxies are memoized so `session.billing === session.billing`.
 *
 * The one name that neither resolves nor synthesizes is a KNOWN sub-handle slot
 * whose harness `/client` subpath was never imported: synthesizing there would
 * hand back a proxy that answers `tools.list()` with a wire `method not found`
 * from a server that is fine — the classic wrong-door degradation. That case
 * throws {@link SessionSubHandleNotRegistered}, naming the import to add.
 * Only `get` is affected: `"tools" in session`, `Object.keys(session)` and
 * util.inspect route through `has`/`ownKeys`/own-property reads, so probes and
 * debugger inspection report absence rather than throwing.
 */
function wrapSessionWireProxy(
  base: SessionHandleBase,
  client: InternalClient,
  sessionId: string,
): SessionHandle {
  const nsCache = new Map<string, unknown>();
  const proxy = new Proxy(base as object, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver); // registered slots + base
      if (prop === "then") return undefined; // never a thenable
      // Known slot, no registration → a forgotten harness `/client` import.
      const importSpecifier = knownSessionHandleExtensionImports()[prop];
      if (importSpecifier !== undefined) {
        throw new SessionSubHandleNotRegistered({ slot: prop, importSpecifier });
      }
      let ns = nsCache.get(prop);
      if (ns === undefined) {
        ns = makeWireNamespace(client, sessionId, prop);
        nsCache.set(prop, ns);
      }
      return ns;
    },
  });
  // The runtime Proxy is a structural superset of every session-scoped wire
  // namespace; the mapped `SessionHandle` type is what constrains callers.
  return proxy as unknown as SessionHandle;
}

// ============================================================================
// ClientSessionExecutionHandle — RPC + progress stream stitched together
// ============================================================================

/**
 * Issues `session/send` with a progress token, opens a `progress(token)`
 * stream on the transport, and stitches both into a single
 * `ClientSessionExecutionHandle` shape (`events()` + `.result` + abort).
 */
function createSessionExecutionHandle<P>(
  client: InternalClient,
  sessionId: string,
  input: ClientSendInput<P>,
): ClientSessionExecutionHandle {
  const progressToken = `p-${client.id}-${nextProgressToken()}`;

  const progressStream = client.transport.progress(progressToken);

  let status: ClientSessionExecutionHandle["status"] = "running";
  let executionId = "";

  const resultPromise = client
    .request("session/send", {
      sessionId,
      messages: input.messages as readonly SendMessageInput[] | undefined,
      props: input.props,
      metadata: input.metadata,
      maxTicks: input.maxTicks,
      stream: input.stream,
      target: input.target,
      // 4b — busy-send behavior (steer/queue) rides the send params (JSON enum).
      onBusy: input.onBusy,
      // Telemetry rung 2 — per-call functionId + metadata (JSON-clean bag).
      telemetry: input.telemetry,
      // trail-response-format-send — the declarative `responseFormat`
      // directive (wire-safe JSON). The client parses the returned
      // `response` text against its own schema.
      responseFormat: input.responseFormat,
      // Widens the progress fan on THIS token to the turn's spawn tree.
      // Omitted when not asked for, so the request body is byte-identical to
      // the pre-fanIn one. See `ClientSendInput.fanIn`.
      ...(input.fanIn !== undefined ? { fanIn: input.fanIn } : {}),
      _meta: { progressToken },
    })
    .then((res) => {
      executionId = res.executionId;
      status = "completed";
      return res.result;
    })
    .catch((err) => {
      status = "error";
      throw err;
    });

  return {
    get executionId() {
      return executionId;
    },
    get status() {
      return status;
    },
    result: resultPromise,
    async abort(reason?: string) {
      status = "aborted";
      await client.request("session/abort", { sessionId, reason });
      await progressStream.close();
    },
    // `events()` returns the event stream, backed by the progress
    // stream. The handle is not itself iterable; `events()` is the one
    // way to consume the stream — matching the server-side
    // `SessionExecutionHandle`.
    // The iterator now COMPLETES on its own: the gateway sends
    // `notifications/progress/complete` once both progress fan-outs drain,
    // and the transport ends this stream on it (which also reaps the token).
    //
    // TWO PRODUCERS, ONE UNION. The gateway multiplexes the execution-event
    // fan-out (`envelope.name === "session:execution:event"`, payload already a
    // `StreamEvent`) and ADR 64 progress SIGNALS (`<surface>:signal:progress`,
    // payload a `ProgressEventPayload`) onto this one token. A signal is
    // yielded as the `type: "progress"` variant of the union built from the
    // payload plus the envelope's SCOPE — the emitter identity a consumer needs
    // to attribute a descendant's frame under `fanIn`, which used to be
    // discarded here. Execution events yield exactly what they always did.
    //
    // Discriminating on `type` rather than stamping the envelope's `name` is
    // the design decision recorded on `ProgressStreamEvent`: six variants of
    // this union already carry a `name` and it is the TOOL name, so a stamp
    // would replace "which tool" with "which frame kind" on the most-consumed
    // frames of the stream.
    async *events(): AsyncGenerator<StreamEvent> {
      for await (const frame of progressStream) {
        const envelope = frame.envelope;
        if (isProgressEventName(envelope.name)) {
          const payload = envelope.payload as ProgressEventPayload;
          // Deliberately NOT fed to the `executionId` learn-step below: a
          // signal's scope names its EMITTER, and under `fanIn` that is a
          // sub-agent's execution. Learning from it would advertise a
          // descendant's execution as this handle's.
          yield {
            type: "progress",
            token: payload.token,
            progress: payload.progress,
            ...omitUndefined({
              total: payload.total,
              message: payload.message,
              sessionId: envelope.scope.sessionId,
              executionId: envelope.scope.executionId,
            }),
          };
          continue;
        }
        // The envelope's payload IS the StreamEvent — server already
        // normalized it.
        const event = envelope.payload as StreamEvent;
        // Learn the execution's id from the FIRST event that names it. Every
        // `StreamEventBase` carries `executionId`, and the send's own response does
        // not arrive until the turn is OVER — so without this the handle advertised
        // `executionId` as `""` for the entire life of the execution, which is
        // precisely when a consumer needs it: to correlate the live turn against
        // the committed entries arriving on the timeline. A UI doing that
        // correlation saw every committed entry as "not mine" and rendered the turn
        // twice — once from the stream, once from the timeline.
        //
        // CAVEAT, stated rather than hidden: this only advances the getter while
        // someone is consuming `events()`. A caller that awaits `.result` alone
        // still sees `""` until it resolves, exactly as before. Making the id known
        // at `send()` time without a consumer means minting it client-side and
        // passing it in the send params (the `clientId` pattern) — a change of
        // id-minting authority, not a tweak. TODO(execution-id-at-send).
        if (executionId === "" && typeof event?.executionId === "string") {
          executionId = event.executionId;
        }
        yield event;
      }
    },
  };
}

let progressTokenCounter = 0;
function nextProgressToken(): number {
  return ++progressTokenCounter;
}
