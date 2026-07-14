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
  ClientElicitation,
  ClientElicitationHandle,
  ClientElicitationStream,
  ClientProtocol,
  ClientSessionExecutionHandle,
  ContentBlock,
  CreateSessionInput,
  EventEnvelope,
  EventQuery,
  GatewayHandle,
  GatewayListAppsResult,
  SendInput,
  SendMessageInput,
  SessionEntry,
  SessionFilter,
  SessionHandle,
  StreamEvent,
  SubscriptionStream,
} from "@agentick/spec-next";
import type { Cursor } from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

interface InternalClient {
  readonly id: string;
  request: ClientProtocol["request"];
  readonly transport: ClientProtocol["transport"];
}

export function makeGatewayHandle(client: InternalClient): GatewayHandle {
  return {
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
    elicitations(opts?: { fromCursor?: Cursor }): ClientElicitationStream {
      return makeElicitationStream(client, sessionId, opts?.fromCursor);
    },
    async respondToElicitation(input): Promise<void> {
      await client.request("session/respond_to_elicitation", {
        sessionId,
        correlationId: input.correlationId,
        outcome: input.outcome,
        ...omitUndefined({ value: input.value, reason: input.reason }),
      });
    },
  };
}

// ============================================================================
// ClientElicitationStream — bus subscription + parser + .accept/.decline/.cancel
// ============================================================================

const ELICITATION_CHANNEL_FQN = "session:channel:elicitation";

interface EnvelopeWithMetadata extends EventEnvelope {
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Build a session-scoped subscription filtered to elicitation request
 * envelopes; parse each into a {@link ClientElicitationHandle} and
 * yield. Closing the stream tears down the underlying subscription.
 */
function makeElicitationStream(
  client: InternalClient,
  sessionId: string,
  fromCursor: Cursor | undefined,
): ClientElicitationStream {
  const sub = client.transport.subscribe(
    { kind: "session", id: sessionId },
    {
      surface: "session",
      name: { exact: ELICITATION_CHANNEL_FQN },
    },
    fromCursor,
  );

  async function* iterator(): AsyncGenerator<ClientElicitationHandle<unknown>> {
    for await (const frame of sub) {
      const env = frame.envelope as EnvelopeWithMetadata;
      // Only request envelopes — responses go on the inbox, not the
      // bus, but a defensive guard keeps us robust if something else
      // ever lands on this channel name.
      if (env.metadata?.requestType !== "request") continue;
      const parsed = parseElicitation(env);
      if (parsed === undefined) continue;
      yield wrapHandle(client, sessionId, parsed);
    }
  }

  const gen = iterator();
  return {
    [Symbol.asyncIterator](): AsyncIterator<ClientElicitationHandle<unknown>> {
      return gen;
    },
    async close(): Promise<void> {
      await sub.close();
    },
  };
}

function parseElicitation(env: EnvelopeWithMetadata): ClientElicitation | undefined {
  const correlationId = env.metadata?.correlationId;
  const replyTo = env.metadata?.replyTo;
  if (typeof correlationId !== "string" || typeof replyTo !== "string") return undefined;
  const payload = env.payload as
    | {
        readonly mode?: "form" | "url";
        readonly message?: string;
        readonly schema?: Readonly<Record<string, unknown>>;
        readonly url?: string;
        readonly elicitationId?: string;
        readonly hints?: Readonly<Record<string, unknown>>;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }
    | undefined;
  if (!payload || typeof payload.message !== "string") return undefined;
  return {
    correlationId,
    replyTo,
    mode: payload.mode ?? "form",
    message: payload.message,
    ...omitUndefined({
      schema: payload.schema,
      url: payload.url,
      elicitationId: payload.elicitationId,
      hints: payload.hints,
      metadata: payload.metadata,
    }),
    receivedAt: Date.now(),
  };
}

function wrapHandle(
  client: InternalClient,
  sessionId: string,
  elic: ClientElicitation,
): ClientElicitationHandle<unknown> {
  const respond = (body: {
    outcome: "accepted" | "declined" | "cancelled";
    value?: unknown;
    reason?: string;
  }): Promise<void> =>
    client
      .request("session/respond_to_elicitation", {
        sessionId,
        correlationId: elic.correlationId,
        outcome: body.outcome,
        ...omitUndefined({ value: body.value, reason: body.reason }),
      })
      .then(() => undefined);
  return {
    ...elic,
    accept(value: unknown): Promise<void> {
      return respond({ outcome: "accepted", value });
    },
    decline(reason?: string): Promise<void> {
      return respond(
        reason !== undefined ? { outcome: "declined", reason } : { outcome: "declined" },
      );
    },
    cancel(reason?: string): Promise<void> {
      return respond(
        reason !== undefined ? { outcome: "cancelled", reason } : { outcome: "cancelled" },
      );
    },
  };
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
