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
  SessionHandleExtensions,
  StreamEvent,
  SubscriptionScope,
  SubscriptionStream,
} from "@agentick/spec-next";
import type { Cursor } from "@agentick/spec-next";
import { onLog as onLogFn, onProgress as onProgressFn } from "./signals.js";
import { channelView as channelViewFn } from "./channel-view.js";
import { applySessionHandleExtensions } from "./session-handle-extensions.js";

interface InternalClient {
  readonly id: string;
  request: ClientProtocol["request"];
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
  // Typed against the BASE (minus the augmented sub-handles) so the literal is
  // fully checked; the registered sub-handles are attached as getters below and
  // asserted at return. In client-core `SessionHandleExtensions` is empty, so this
  // is just `SessionHandle`; in a harness package's compilation it drops that
  // package's slot (added by the getter), keeping the slot NON-optional (ADR 87).
  const handle: Omit<SessionHandle, keyof SessionHandleExtensions> = {
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
    // TODO(4b): `session/queue` is a DANGLING wire method — declared in
    // wire params + this client stub + the retry predicates, but with NO
    // server-side gateway handler and no `queue` on SessionHarnessProtocol.
    // Its intended "enqueue for after the session settles" semantic is now
    // owned by `send({ delivery: "followUp" })`. Fold this into `send` (or
    // wire a real `session/queue` handler that delegates to a followUp send)
    // and drop the redundant method + params in the next wire sweep.
    async queue(messages) {
      return client.request("session/queue", {
        sessionId,
        messages: (messages ?? []) as readonly SendMessageInput[],
      });
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
  applySessionHandleExtensions(handle, client as unknown as ClientProtocol, sessionId);
  return handle as SessionHandle;
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
      // 4b — steer/follow-up delivery rides the send params (JSON enum).
      delivery: input.delivery,
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
