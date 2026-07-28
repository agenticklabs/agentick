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
  ChannelView,
  ChannelViewConfig,
  ClientProtocol,
  ClientSessionExecutionHandle,
  ClientTransport,
  ContentBlock,
  CreateSessionInput,
  EventQuery,
  GatewayHandle,
  GatewayListAppsResult,
  HandleSubscriptions,
  SendInput,
  SendMessageInput,
  SessionEntry,
  SessionFilter,
  SessionHandle,
  SessionHandleBase,
  StreamEvent,
  SubscriptionScope,
  SubscriptionStream,
  WireMethod,
} from "@agentick/spec";
import type { Cursor } from "@agentick/spec";
import { onLog as onLogFn, onProgress as onProgressFn } from "./signals.js";
import { channelView as channelViewFn } from "./channel-view.js";
import {
  applySessionHandleExtensions,
  knownSessionHandleExtensionImports,
  SessionSubHandleNotRegistered,
} from "./session-handle-extensions.js";

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
      });
    },
    async getSession(sessionId): Promise<SessionEntry> {
      return client.request("app/get_session", { appId, sessionId }) as Promise<SessionEntry>;
    },
    async listSessions(filter?: SessionFilter) {
      const result = await client.request("app/list_sessions", { appId, filter });
      return result.sessions as readonly SessionEntry[];
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

export function makeSessionHandle(client: InternalClient, sessionId: string): SessionHandle {
  // Typed against the hand-written BASE ({@link SessionHandleBase}) so the literal
  // is fully checked. The registered sub-handles (`session.knobs`, …) are attached
  // as getters below (ADR 87); the wire-DERIVED namespace methods
  // (`session.billing.approve`, …) are synthesized by the Proxy wrapper at return.
  // The full `SessionHandle` (base ∧ sub-handles ∧ wire namespaces) is reached by
  // CASTING the Proxy — never by widening.
  const handle: SessionHandleBase = {
    ...scopedSubscriptions(client, { kind: "session", id: sessionId }),
    id: sessionId,
    send<P = unknown>(input: SendInput<P>): ClientSessionExecutionHandle {
      return createSessionExecutionHandle(client, sessionId, input);
    },
    async dispatch(tool, input): Promise<readonly ContentBlock[]> {
      const result = await client.request("session/dispatch", {
        sessionId,
        tool,
        input,
      });
      return result.content;
    },
    async abort(reason) {
      await client.request("session/abort", { sessionId, reason });
    },
    async snapshot(): Promise<unknown> {
      const result = await client.request("session/snapshot", { sessionId });
      return result.snapshot;
    },
    async rebind(auth) {
      await client.request("session/rebind", { sessionId, auth });
    },
    async close() {
      await client.request("session/close", { sessionId });
    },
    events(query?: EventQuery, fromCursor?: Cursor): SubscriptionStream {
      return client.transport.subscribe({ kind: "session", id: sessionId }, query, fromCursor);
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
  const handleClient = withMiddlewareTransport(client);
  applySessionHandleExtensions(handle, handleClient, sessionId);
  // B2 slice 4 — WIRE PROXY: wrap so an unregistered namespace access
  // (`session.billing`) synthesizes a namespace whose methods issue
  // `client.request("billing/<method>", { sessionId, ...params })`. Registered
  // sub-handles and base members are served from `handle` untouched; only
  // unknown namespaces fall through to synthesis. Cast to the mapped
  // `SessionHandle` — the runtime is a superset, the type is the guard.
  return wrapSessionWireProxy(handle, client, sessionId);
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
 * untouched; symbols and `then` never synthesize (so the handle is not a
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

/**
 * Synthesize a namespace object for `namespace` whose every accessed method
 * `m` issues `client.request("<namespace>/<m>", { sessionId, ...params })`. No
 * per-method knowledge is needed — a typo can't compile (the mapped type is the
 * guard), and an unknown-at-runtime method is rejected by the server. Method
 * functions are memoized.
 */
function makeWireNamespace(client: InternalClient, sessionId: string, namespace: string): unknown {
  const methodCache = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>();
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      let fn = methodCache.get(prop);
      if (fn === undefined) {
        const method = `${namespace}/${prop}` as WireMethod;
        fn = (params?: Record<string, unknown>) =>
          client.request(method, { sessionId, ...(params ?? {}) } as never);
        methodCache.set(prop, fn);
      }
      return fn;
    },
  });
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
  input: SendInput<P>,
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
    // TODO(mixed-stream): this yields EVERY frame on the token as a
    // `StreamEvent`, but the gateway multiplexes two producers onto it — the
    // execution-event fan-out (`envelope.name === "session:execution:event"`)
    // AND ADR 64 progress SIGNALS (`<surface>:signal:progress`, payload
    // `ProgressEventPayload`). A tool calling `ctx.progress(...)` therefore
    // hands a consumer a non-StreamEvent wearing a StreamEvent type. The fix
    // is to discriminate on `envelope.name` here (or expose the envelope);
    // until then a consumer MUST ignore unknown `type` values rather than
    // `switch` with a throwing default.
    async *events(): AsyncGenerator<StreamEvent> {
      for await (const frame of progressStream) {
        // The envelope's payload IS the StreamEvent — server already
        // normalized it.
        yield frame.envelope.payload as StreamEvent;
      }
    },
  };
}

let progressTokenCounter = 0;
function nextProgressToken(): number {
  return ++progressTokenCounter;
}
