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
  ClientProtocol,
  ClientSessionExecutionHandle,
  ContentBlock,
  CreateSessionInput,
  EventQuery,
  GatewayHandle,
  GatewayListAppsResult,
  SendInput,
  SendMessageInput,
  SendResult,
  SessionEntry,
  SessionFilter,
  SessionHandle,
  StreamEvent,
  SubscriptionStream,
} from "@agentick/spec-next";
import type { Cursor } from "@agentick/spec-next";

interface InternalClient {
  readonly id: string;
  request: ClientProtocol["request"];
  readonly transport: ClientProtocol["transport"];
}

export function makeGatewayHandle(client: InternalClient): GatewayHandle {
  return {
    async listApps(): Promise<GatewayListAppsResult> {
      return client.request("gateway/listApps", {});
    },
    async getApp(id) {
      return client.request("gateway/getApp", { appId: id });
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
    id: appId,
    async createSession<P = unknown>(input?: CreateSessionInput<P>) {
      return client.request("app/createSession", {
        appId,
        sessionId: input?.sessionId,
        metadata: input?.metadata,
      });
    },
    async getSession(sessionId): Promise<SessionEntry> {
      return client.request("app/getSession", { appId, sessionId }) as Promise<SessionEntry>;
    },
    async listSessions(filter?: SessionFilter) {
      const result = await client.request("app/listSessions", { appId, filter });
      return result.sessions as readonly SessionEntry[];
    },
    async runOnce<P = unknown>(input: SendInput<P>) {
      return client.request("app/runOnce", {
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
  return {
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
}

// ============================================================================
// ClientSessionExecutionHandle — RPC + progress stream stitched together
// ============================================================================

/**
 * Issues `session/send` with a progress token, opens a `progress(token)`
 * stream on the transport, and stitches both into a single
 * `ClientSessionExecutionHandle` shape (AsyncIterable + `.result` + abort).
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
      _meta: { progressToken },
    })
    .then((res) => {
      executionId = res.executionId;
      status = "completed";
      return res.result as unknown as SendResult;
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
    async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
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
