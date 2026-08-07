/**
 * Client-side client-tool CALL resource handle — the far side of the
 * `session:channel:tool_call` request channel plus the client-tool wire commands,
 * on the unified `ClientHandle` contract (B2 slice 3,
 * `docs/proposals/v2/client-handles.md`).
 *
 * `clientToolCallsHandle` folds the tool-call channel into the set of PENDING
 * client-handled calls and presents them as ITEM HANDLES: `list()` returns
 * `ClientToolCallHandle[]` — each a call's data (toolCallId, name, validated
 * input) PLUS its bound `.respond(result)`. The item handle is constructed
 * IDENTICALLY whether the call arrived via the slice-2 SNAPSHOT frame (pending
 * before this client connected — the live-only fix) or a live relay delta: ONE
 * constructor, both sources. A client connecting mid-call sees the outstanding
 * call in `list()` and `list()[0].respond(result)` round-trips like a live one.
 *
 * The contract:
 *   - CORE — `subscribe(cb)` (zero-arg store contract; fires when the pending set
 *     changes) + `close()`.
 *   - {@link Enumerable}<{@link ClientToolCallHandle}> — `list()` = current
 *     PENDING (correlated) calls, `get(correlationId)`.
 *   - {@link Respondable} — `respond(correlationId, result)`, the by-id escape
 *     hatch. Replying removes the call from `list()`.
 *   - WRITE + control verbs (Ryan's Q1a — the loose session functions folded onto
 *     the handle): `set(declarations)` (declare this client's tool set over
 *     `session/set_client_tools`), `route(handlers, opts?)` (the ergonomic router:
 *     dispatch each inbound call to a handler, auto-respond), `confirm(policy)`
 *     (approve/deny/predicate over `tool_confirmation` elicitations).
 *
 * Fire-and-forget calls (a stage-1 non-`requiresResponse` tool, relayed with NO
 * correlationId) are NOT pending — nothing responds to them — so they never enter
 * `list()`. They DO reach `route`'s dispatch (the internal frame tap, surviving
 * only inside the fold — client-handles §3): the router runs the handler for its
 * side-effect and skips the respond.
 *
 * Async iteration is REMOVED (principle #4 — no handle is `AsyncIterable`). The
 * frame feed survives only internally, feeding the fold and `route`.
 *
 * @verifiedBy packages/tool-executor/src/__tests__/client-tool-router.spec.ts
 * @verifiedBy packages/tool-executor/src/__tests__/client-tool-calls.conformance.spec.ts
 */

import {
  liveStore,
  type ClientHandle,
  type Enumerable,
  type Respondable,
} from "@agentick/client-core";
import { NOOP_METRICS, OFF_TRACE, createLog } from "@agentick/spec";
import type {
  ClientRuntimeContext,
  ClientToolDeclaration,
  ClientTransport,
  EventEnvelope,
  SessionSetClientToolsResult,
  ToolResultInput,
  Unsubscribe,
} from "@agentick/spec";

import { TOOL_CALL_CHANNEL_FQN, type PendingToolCall } from "../tool-call-schema.js";
import { confirmClientTools, type ConfirmPolicy } from "./confirm.js";
import {
  toClientToolDeclaration,
  type ClientTool,
  type ClientToolCtx,
} from "./create-client-tool.js";
import { clientToolCtx, routeClientTools, type UseClientToolsOptions } from "./use-client-tools.js";

/**
 * The client surface the handle consumes — a subscribe stream (the fold's input)
 * + `request` (the reply / declare commands). A minimal `Pick<ClientTransport, …>`
 * so a full `ClientProtocol` satisfies it (floors, not ceilings). Uniform with
 * `session.knobs` / `session.tasks` / `session.elicitations`.
 */
export interface ClientToolCallsClient {
  readonly transport: Pick<ClientTransport, "subscribe" | "request">;
}

interface EnvelopeWithMetadata extends EventEnvelope {
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Parsed view of one inbound tool-call relay — the wire payload
 * ({@link import("../tool-call-schema.js").ToolCallRequestPayload}) plus the
 * `correlationId` lifted from the envelope metadata and a client-stamped
 * `receivedAt`. `correlationId` is `undefined` for a fire-and-forget notify.
 */
export interface ClientToolCall {
  readonly toolCallId: string;
  readonly name: string;
  /** The VALIDATED input from the relay payload (post inputSchema validation). */
  readonly input: unknown;
  /**
   * The connection this call was addressed to — the one whose request started
   * the turn. `undefined` means "no particular client", which every attached
   * client should read as addressed to all of them.
   */
  readonly target: string | undefined;
  /**
   * Correlation key from the wire envelope metadata — required to reply.
   * `undefined` for a fire-and-forget (one-way notify) relay: there is no
   * pending dispatch to resolve, so {@link ClientToolCallHandle.respond} is a
   * no-op.
   */
  readonly correlationId: string | undefined;
  /** Client-stamped receive time (`Date.now()`). */
  readonly receivedAt: number;
}

/**
 * A {@link ClientToolCall} with a typed `.respond` shortcut that threads the
 * call's `correlationId`. When the call is fire-and-forget
 * (`correlationId === undefined`), `.respond` resolves immediately without
 * sending — nothing is suspended.
 */
export interface ClientToolCallHandle extends ClientToolCall {
  /** Relay this call's result to the server. No-op when fire-and-forget. */
  respond(result: ToolResultInput): Promise<void>;
}

/**
 * A client-side handler for one client tool.
 *
 * Takes the SAME ctx a `createClientTool` handler does — the call, an
 * `AbortSignal`, and the client's `log`/`trace`/`metrics`/identity.
 */
export type ClientToolHandler = (
  input: unknown,
  ctx: ClientToolCtx,
) => ToolResultInput | Promise<ToolResultInput>;

/** Options for {@link ClientToolCallsHandle.route}. */
export interface RouteClientToolsOptions {
  /**
   * Fallback for a tool with no entry in `handlers`. Default: respond with an
   * error result `no client handler for "<name>"`.
   */
  readonly onUnknown?: ClientToolHandler;
}

/**
 * The client-tool-call resource handle — the `ClientHandle` contract:
 * {@link Enumerable} pending calls (as item handles) + {@link Respondable} by id,
 * plus the folded-on `set`/`route`/`confirm` verbs. A plain structural shape
 * (floors, not ceilings) — it MAY carry more.
 */
export interface ClientToolCallsHandle
  extends ClientHandle, Enumerable<ClientToolCallHandle>, Respondable<ToolResultInput> {
  /** The current PENDING (correlated) calls as item handles. */
  list(): readonly ClientToolCallHandle[];
  /** Look one pending call up by `correlationId`. */
  get(correlationId: string): ClientToolCallHandle | undefined;
  /**
   * Reply to a suspended call by `correlationId` (the escape hatch for code not
   * holding the item handle). Rejects an unknown/already-answered id.
   */
  respond(correlationId: string, result: ToolResultInput): Promise<void>;
  /**
   * DECLARE this client's full CLIENT-HANDLED tool set into the session over
   * `session/set_client_tools` — a whole-slice REPLACE (register a tool present
   * in the set, unregister one absent; the set IS the truth). Resolves to
   * `{ count }`.
   */
  set(declarations: readonly ClientToolDeclaration[]): Promise<SessionSetClientToolsResult>;
  /**
   * The ergonomic router: dispatch each inbound call to `handlers[name]` (or
   * `opts.onUnknown`), await it, and relay the result via the call's `.respond`.
   * A handler THROW is answered with an error result — a suspended call is never
   * left hanging. Fire-and-forget calls still dispatch their handler but skip the
   * respond. Returns an {@link Unsubscribe} that stops routing (the handle's own
   * `close()` tears the subscription down).
   */
  route(
    handlers: Readonly<Record<string, ClientToolHandler>>,
    opts?: RouteClientToolsOptions,
  ): Unsubscribe;
  /**
   * Declare AND handle a set of {@link ClientTool}s — the whole-tool twin of
   * `set` + `route`, which cannot be authored out of step because the
   * declaration is projected from the same object that carries the handler.
   *
   * Publishes the projected declarations (a whole-slice replace, like `set`),
   * then routes inbound calls to them. A tool whose `accepts` returns false is
   * left UNANSWERED — another attached client is expected to take it.
   *
   * Resolves once the declarations are published; the returned
   * {@link Unsubscribe} stops routing.
   */
  use(tools: readonly ClientTool[], opts?: UseClientToolsOptions): Promise<Unsubscribe>;
  /**
   * Apply a confirmation {@link ConfirmPolicy} to inbound tool-confirmation
   * elicitations (`hints.kind === "tool_confirmation"`): `"approve"` / `"deny"` /
   * a predicate. Non-confirmation elicitations are left untouched. Returns an
   * {@link Unsubscribe}.
   */
  confirm(policy: ConfirmPolicy): Unsubscribe;
  /** Tear down the underlying tool-call subscription. */
  close(): void;
}

/**
 * Open the client-tool-call resource handle. Folds the channel's SNAPSHOT frame
 * (pending calls, pre-connection) and live relay deltas into the pending set;
 * `list()`/`get()` read it; replying removes the call. Single-consumer.
 */
export function clientToolCallsHandle(
  client: ClientToolCallsClient,
  sessionId: string,
): ClientToolCallsHandle {
  const sub = client.transport.subscribe(
    { kind: "session", id: sessionId },
    { surface: "session", name: { exact: TOOL_CALL_CHANNEL_FQN } },
  );

  const pending = new Map<string, ClientToolCallHandle>();
  /** This client's server-BOUND id, read per call: the handle outlives a handshake. */
  const selfId = (): string =>
    (client as { runtime?: { clientId: string } }).runtime?.clientId ?? "";
  // TODO(per-execution-abort): this aborts when the HANDLE closes, not when the
  // execution behind a given call dies. A handler mid-fetch on a cancelled turn
  // still has no signal — that needs the execution id on the relay.
  const lifetime = new AbortController();
  const store = liveStore<readonly ClientToolCallHandle[], void>([], () => {
    lifetime.abort();
    void sub.close();
  });
  const notify = (): void => store.set([...pending.values()]);

  // The internal frame tap (survives only here): every parsed call — correlated
  // AND fire-and-forget — is broadcast to `route` listeners; only correlated
  // calls enter the pending set (list()).
  const callListeners = new Set<(call: ClientToolCallHandle) => void>();

  const send = async (correlationId: string, result: ToolResultInput): Promise<void> => {
    await respondToToolCall(client, sessionId, correlationId, result);
    if (pending.delete(correlationId)) notify();
  };

  const wrap = (call: ClientToolCall): ClientToolCallHandle => ({
    ...call,
    respond: (result: ToolResultInput): Promise<void> =>
      call.correlationId === undefined ? Promise.resolve() : send(call.correlationId, result),
  });

  // ONE gate for every path that offers a call to a handler. `route` and `use`
  // both listen here, and a third would too — the rule cannot be missed by a
  // dispatch path that forgets to apply it.
  const ingest = (call: ClientToolCallHandle): void => {
    // Addressed to another client. Not ours to run, not ours to list, and not
    // ours to answer — leaving it in `list()` would offer a `.respond` that
    // steals the addressed client's work.
    if (call.target !== undefined && call.target !== selfId()) return;
    if (call.correlationId !== undefined) {
      pending.set(call.correlationId, call);
      notify();
    }
    for (const l of [...callListeners]) {
      try {
        l(call);
      } catch {
        /* isolate a bad router reaction */
      }
    }
  };

  void (async () => {
    for await (const frame of sub) {
      if (store.closed) return;
      const env = frame.envelope as EnvelopeWithMetadata;
      const snapshot = asSnapshotFrame(env.payload);
      if (snapshot) {
        // Authoritative pending set — clear then reseed. LISTED, not
        // dispatched: a client that reconnects mid-call sees the outstanding
        // call and may answer it, but nothing re-runs a handler that may
        // already have run before the socket dropped.
        pending.clear();
        for (const req of snapshot.requests) {
          const call = parseSnapshotCall(req);
          if (call && (call.target === undefined || call.target === selfId())) {
            pending.set(req.correlationId, wrap(call));
          }
        }
        notify();
        continue;
      }
      const parsed = parseLiveCall(env);
      if (parsed) ingest(wrap(parsed));
    }
  })().catch(() => {
    // The subscription died rather than went quiet — the server refused it, or
    // it did not survive a reconnect, and the transport ends the stream with
    // the reason instead of letting it hang (#263). This loop FLOATS, so an
    // uncaught rejection here is fatal under Node's default policy.
    //
    // Closing the store is the honest report available at this layer: `status`
    // becomes `"closed"`, so a consumer can tell a dead relay from a quiet one
    // rather than waiting forever for calls that will never arrive.
    // TODO(dead-feed-notify): `liveStore.close()` clears its listeners without
    // notifying them, so a subscribed consumer is not woken.
    store.close();
  });

  return {
    list: () => store.get(),
    get: (correlationId) => pending.get(correlationId),
    subscribe: (cb: () => void): Unsubscribe => store.subscribe(() => cb()),
    close: () => store.close(),
    respond: (correlationId, result) => {
      if (!pending.has(correlationId)) {
        return Promise.reject(new Error(`unknown tool call "${correlationId}"`));
      }
      return send(correlationId, result);
    },
    set: (declarations) =>
      client.transport.request("session/set_client_tools", { sessionId, declarations }),
    route: (handlers, opts) => {
      const listener = (call: ClientToolCallHandle): void => {
        void dispatchCall(call, handlers, runtimeOf(client), lifetime.signal, opts);
      };
      callListeners.add(listener);
      return () => {
        callListeners.delete(listener);
      };
    },
    confirm: (policy) => confirmClientTools(client, sessionId, policy),
    use: async (tools, opts) => {
      await client.transport.request("session/set_client_tools", {
        sessionId,
        declarations: tools.map(toClientToolDeclaration),
      });
      return routeClientTools(
        { onCall: (l) => (callListeners.add(l), () => void callListeners.delete(l)) },
        tools,
        selfId,
        runtimeOf(client),
        lifetime.signal,
        opts,
      );
    },
  };
}

/** The client's runtime, or the off-path stand-in when built over a bare transport. */
function runtimeOf(client: ClientToolCallsClient): ClientRuntimeContext {
  return (client as { runtime?: ClientRuntimeContext }).runtime ?? OFF_RUNTIME;
}

/**
 * Stands in when the handle was built over a bare transport rather than a full
 * client — a handler still gets `ctx.log`/`ctx.trace` that are safe to call.
 */
const OFF_RUNTIME: ClientRuntimeContext = {
  clientId: "",
  connectionId: undefined,
  log: createLog(() => {}),
  trace: OFF_TRACE,
  metrics: NOOP_METRICS,
  activeSpan: () => undefined,
};

/**
 * Reply to a suspended client-handled tool call by `correlationId` — the direct
 * command for code that does not hold the handle's pending set (the by-id escape
 * hatch, twin of `respondToElicitation`). Routes through
 * `session/respond_to_tool_call`; the server is idempotent on unknown/resolved
 * ids. The handle's guarded `respond` and the item `.respond` use this path.
 */
export async function respondToToolCall(
  client: ClientToolCallsClient,
  sessionId: string,
  correlationId: string,
  result: ToolResultInput,
): Promise<void> {
  await client.transport.request("session/respond_to_tool_call", {
    sessionId,
    correlationId,
    result,
  });
}

async function dispatchCall(
  call: ClientToolCallHandle,
  handlers: Readonly<Record<string, ClientToolHandler>>,
  runtime: ClientRuntimeContext,
  signal: AbortSignal,
  opts?: RouteClientToolsOptions,
): Promise<void> {
  const handler = handlers[call.name] ?? opts?.onUnknown ?? unknownToolHandler;
  let result: ToolResultInput;
  try {
    result = await handler(call.input, clientToolCtx(call, runtime, signal));
  } catch (err) {
    result = errorResult(err instanceof Error ? err.message : String(err));
  }
  // Fire-and-forget relays carry no correlationId — `.respond` is a no-op there.
  await call.respond(result);
}

const unknownToolHandler: ClientToolHandler = (_input, ctx) =>
  errorResult(`no client handler for "${ctx.name}"`);

function errorResult(message: string): ToolResultInput {
  return { content: message, isError: true };
}

/** Narrow an envelope payload to the channel's opening SNAPSHOT frame. */
function asSnapshotFrame(
  payload: unknown,
): { readonly requests: readonly PendingToolCall[] } | undefined {
  if (
    payload !== null &&
    typeof payload === "object" &&
    (payload as { kind?: unknown }).kind === "snapshot" &&
    Array.isArray((payload as { requests?: unknown }).requests)
  ) {
    return payload as { readonly requests: readonly PendingToolCall[] };
  }
  return undefined;
}

/** Build a pending call off a snapshot {@link PendingToolCall} (always correlated). */
function parseSnapshotCall(req: PendingToolCall): ClientToolCall | undefined {
  const p = req.payload as
    | {
        readonly toolCallId?: unknown;
        readonly name?: unknown;
        readonly input?: unknown;
        readonly target?: unknown;
      }
    | undefined;
  if (!p || typeof p.toolCallId !== "string" || typeof p.name !== "string") return undefined;
  return {
    toolCallId: p.toolCallId,
    name: p.name,
    input: p.input,
    target: typeof p.target === "string" ? p.target : undefined,
    correlationId: req.correlationId,
    receivedAt: Date.now(),
  };
}

/** Build a call off a live relay envelope (correlationId may be absent). */
function parseLiveCall(env: EnvelopeWithMetadata): ClientToolCall | undefined {
  const p = env.payload as
    | {
        readonly toolCallId?: unknown;
        readonly name?: unknown;
        readonly input?: unknown;
        readonly target?: unknown;
      }
    | undefined;
  if (!p || typeof p.toolCallId !== "string" || typeof p.name !== "string") return undefined;
  const correlationId = env.metadata?.correlationId;
  return {
    toolCallId: p.toolCallId,
    name: p.name,
    input: p.input,
    target: typeof p.target === "string" ? p.target : undefined,
    correlationId: typeof correlationId === "string" ? correlationId : undefined,
    receivedAt: Date.now(),
  };
}
