/**
 * Client-side client-tool CALL surface — the far side of the
 * `session:channel:tool_call` request channel plus the
 * `session/respond_to_tool_call` reply command (stage 3).
 *
 * `clientToolCallStream` opens a session-scoped subscription to the tool-call
 * channel, parses each inbound relay into a {@link ClientToolCallHandle}
 * (validated `input` + a typed `.respond`), and yields it. `routeClientTools`
 * is the ergonomic router on top: dispatch each call to a registered handler,
 * auto-respond with its result, and turn a throw / unknown-tool into an error
 * result — never leaving a suspended call hanging. `respondToToolCall` is the
 * direct reply for code holding a bare `correlationId` (the handle's `.respond`
 * routes through the same wire method).
 *
 * Mirrors `@agentick/elicitation-next/client`'s `elicitations.ts`: it taps the
 * raw subscription for the envelope's correlation metadata but PRESENTS the
 * uniform `ChannelStream`. Depends on `@agentick/client-core-next` + spec types
 * only — NOT on the tool-executor harness runtime — so it stays out of a
 * browser bundle.
 *
 * **Fire-and-forget.** A stage-1 non-`requiresResponse` client tool is relayed
 * via a one-way notify (NO correlationId). Those frames STILL surface here (the
 * client may want to render/react), but their handle carries
 * `correlationId: undefined` and `.respond` is a no-op — there is nothing to
 * reply to. The router still dispatches the handler (the client-side
 * side-effect) but skips the respond. Discriminate on `correlationId` presence.
 *
 * @verifiedBy packages-next/tool-executor/src/__tests__/client-tool-router.spec.ts
 */

import type {
  ChannelStream,
  ClientProtocol,
  Cursor,
  EventEnvelope,
  ToolResultInput,
  Unsubscribe,
} from "@agentick/spec-next";

import { TOOL_CALL_CHANNEL_FQN } from "../tool-call-schema.js";

interface EnvelopeWithMetadata extends EventEnvelope {
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Parsed view of a single inbound tool-call relay — the wire payload
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
 * A {@link ClientToolCall} with a typed `.respond` shortcut that routes through
 * the session's `respondToToolCall`, threading the call's `correlationId`. When
 * the call is fire-and-forget (`correlationId === undefined`), `.respond`
 * resolves immediately without sending — nothing is suspended.
 */
export interface ClientToolCallHandle extends ClientToolCall {
  /** Relay this call's result to the server. No-op when fire-and-forget. */
  respond(result: ToolResultInput): Promise<void>;
}

/**
 * The client-tool-call resource handle — the READ surface
 * ({@link ChannelStream}, uniform with `session.tasks` / `session.elicitations`)
 * PLUS the by-id WRITE command. Read via `.onChange`/`for await` (each frame a
 * {@link ClientToolCallHandle}); write by `correlationId` via
 * `.respond(correlationId, result)` (the escape hatch for code not holding a
 * handle — the per-item `.respond` uses the same path).
 */
export interface ClientToolCallsHandle extends ChannelStream<ClientToolCallHandle> {
  respond(correlationId: string, result: ToolResultInput): Promise<void>;
}

/**
 * Open the client-tool-call resource handle. Like elicitation, it opts OUT of
 * the `channelView` fold — each frame is a discrete call to dispatch, not state
 * to materialize — tapping the raw subscription for correlation metadata while
 * presenting the uniform `ChannelStream` + `.respond`. Single-consumer.
 *
 * Surfaces BOTH correlated requests (`requiresResponse` tools) and one-way
 * notifies (fire-and-forget tools); discriminate on `correlationId` presence.
 */
export function clientToolCallStream(
  client: ClientProtocol,
  sessionId: string,
  fromCursor?: Cursor,
): ClientToolCallsHandle {
  const sub = client.transport.subscribe(
    { kind: "session", id: sessionId },
    { surface: "session", name: { exact: TOOL_CALL_CHANNEL_FQN } },
    fromCursor,
  );

  async function* iterate(): AsyncGenerator<ClientToolCallHandle> {
    for await (const frame of sub) {
      const parsed = parseToolCall(frame.envelope as EnvelopeWithMetadata);
      if (parsed === undefined) continue;
      yield wrapHandle(client, sessionId, parsed);
    }
  }

  return {
    [Symbol.asyncIterator]: iterate,
    onChange(listener: (call: ClientToolCallHandle) => void): Unsubscribe {
      let active = true;
      void (async () => {
        try {
          for await (const call of iterate()) {
            if (!active) break;
            listener(call);
          }
        } catch {
          // torn down — nothing to surface
        }
      })();
      return () => {
        active = false;
      };
    },
    respond(correlationId: string, result: ToolResultInput): Promise<void> {
      return respondToToolCall(client, sessionId, correlationId, result);
    },
    close(): void {
      void sub.close();
    },
  };
}

/**
 * Reply to a suspended client-handled tool call by `correlationId` — the direct
 * command for code that does not hold a {@link ClientToolCallHandle}. Routes
 * through `session/respond_to_tool_call` (the handle's `.respond` and the
 * router both use this path).
 */
export async function respondToToolCall(
  client: ClientProtocol,
  sessionId: string,
  correlationId: string,
  result: ToolResultInput,
): Promise<void> {
  await client.request("session/respond_to_tool_call", { sessionId, correlationId, result });
}

/** A client-side handler for one client tool. */
export type ClientToolHandler = (
  input: unknown,
  ctx: { readonly toolCallId: string; readonly name: string },
) => ToolResultInput | Promise<ToolResultInput>;

/** Options for {@link routeClientTools}. */
export interface RouteClientToolsOptions {
  /**
   * Fallback for a tool with no entry in `handlers`. Default: respond with an
   * error result `no client handler for "<name>"`.
   */
  readonly onUnknown?: ClientToolHandler;
}

/**
 * Subscribe to `clientToolCalls` and route each call to `handlers[name]` (or
 * `opts.onUnknown`), awaiting the handler and relaying its result via
 * `handle.respond`. A handler THROW is caught and answered with an error
 * result — a suspended call is never left hanging. Fire-and-forget calls (no
 * correlationId) still dispatch the handler for its side-effect but skip the
 * respond. Returns an {@link Unsubscribe} that stops routing AND closes the
 * underlying subscription.
 */
export function routeClientTools(
  client: ClientProtocol,
  sessionId: string,
  handlers: Readonly<Record<string, ClientToolHandler>>,
  opts?: RouteClientToolsOptions,
): Unsubscribe {
  const stream = clientToolCallStream(client, sessionId);
  const unsub = stream.onChange((call) => {
    void dispatchCall(call, handlers, opts);
  });
  return () => {
    unsub();
    stream.close();
  };
}

async function dispatchCall(
  call: ClientToolCallHandle,
  handlers: Readonly<Record<string, ClientToolHandler>>,
  opts?: RouteClientToolsOptions,
): Promise<void> {
  const handler = handlers[call.name] ?? opts?.onUnknown ?? unknownToolHandler;
  let result: ToolResultInput;
  try {
    result = await handler(call.input, { toolCallId: call.toolCallId, name: call.name });
  } catch (err) {
    result = errorResult(err instanceof Error ? err.message : String(err));
  }
  // Fire-and-forget relays carry no correlationId — nothing to resume.
  if (call.correlationId !== undefined) await call.respond(result);
}

const unknownToolHandler: ClientToolHandler = (_input, ctx) =>
  errorResult(`no client handler for "${ctx.name}"`);

function errorResult(message: string): ToolResultInput {
  return { content: message, isError: true };
}

function parseToolCall(env: EnvelopeWithMetadata): ClientToolCall | undefined {
  const payload = env.payload as
    | { readonly toolCallId?: unknown; readonly name?: unknown; readonly input?: unknown }
    | undefined;
  if (!payload || typeof payload.toolCallId !== "string" || typeof payload.name !== "string") {
    return undefined;
  }
  const correlationId = env.metadata?.correlationId;
  return {
    toolCallId: payload.toolCallId,
    name: payload.name,
    input: payload.input,
    correlationId: typeof correlationId === "string" ? correlationId : undefined,
    receivedAt: Date.now(),
  };
}

function wrapHandle(
  client: ClientProtocol,
  sessionId: string,
  call: ClientToolCall,
): ClientToolCallHandle {
  return {
    ...call,
    respond(result: ToolResultInput): Promise<void> {
      if (call.correlationId === undefined) return Promise.resolve();
      return respondToToolCall(client, sessionId, call.correlationId, result);
    },
  };
}
