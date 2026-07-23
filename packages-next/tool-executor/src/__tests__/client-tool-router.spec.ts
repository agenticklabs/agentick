/**
 * `session.clientToolCalls.route(...)` — the client-side tool-call ROUTER (stage
 * 3), now a verb on the `ClientToolCallsHandle` (B2 slice 3).
 *
 * A stub transport pushes `session:channel:tool_call` frames through a
 * controllable subscription and records outbound `transport.request(...)` calls.
 * Verifies:
 *
 *   1. A correlated relay → the matching handler runs → `session/respond_to_tool_call`
 *      is sent with the handler's result.
 *   2. An unknown tool → the default onUnknown error result is relayed.
 *   3. A handler THROW → an error result is relayed (call never left hanging).
 *   4. A fire-and-forget relay (NO correlationId) → the handler still runs, but
 *      NO respond is sent — and it never enters `list()`.
 *   5. A custom `opts.onUnknown` overrides the default.
 *   6. `route`'s Unsubscribe stops routing; `handle.close()` closes the stream.
 */

import { describe, expect, it } from "vitest";
import type {
  Cursor,
  EventFrame,
  ProtocolEvent,
  SubscriptionStream,
  WireMethod,
  WireParams,
} from "@agentick/spec-next";
import { waitFor } from "@agentick/utils-next/testing";

import { TOOL_CALL_CHANNEL_FQN } from "../tool-call-schema.js";
import { clientToolCallsHandle, type ClientToolCallsClient } from "../client/client-tool-calls.js";

interface PushStream extends SubscriptionStream {
  emit(payload: unknown, correlationId?: string): void;
  readonly isClosed: boolean;
}

function pushStream(): PushStream {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let closed = false;
  let n = 0;
  return {
    subscriptionId: "sub-test",
    get isClosed() {
      return closed;
    },
    emit(payload: unknown, correlationId?: string): void {
      const f: EventFrame = {
        cursor: { value: ++n } as unknown as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "session",
          name: TOOL_CALL_CHANNEL_FQN,
          phase: "delta",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload,
          ...(correlationId !== undefined
            ? { metadata: { requestType: "request", correlationId, replyTo: "inbox:x" } }
            : { metadata: { requestType: "notify" } }),
        } as unknown as ProtocolEvent,
      };
      const w = waiters.shift();
      if (w) w({ value: f, done: false });
      else buffer.push(f);
    },
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}

interface RequestRecord {
  readonly method: string;
  readonly params: unknown;
}

function stubClient(stream: SubscriptionStream): {
  client: ClientToolCallsClient;
  seen: RequestRecord[];
} {
  const seen: RequestRecord[] = [];
  const client: ClientToolCallsClient = {
    transport: {
      subscribe(): SubscriptionStream {
        return stream;
      },
      request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        seen.push({ method, params });
        return Promise.resolve(null);
      },
    } as ClientToolCallsClient["transport"],
  };
  return { client, seen };
}

function toolCall(name: string, input: unknown, toolCallId = "tc-1"): unknown {
  return { toolCallId, name, input };
}

describe("clientToolCalls.route — correlated relays", () => {
  it("runs the matching handler and relays its result via session/respond_to_tool_call", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const seenInput: unknown[] = [];

    const handle = clientToolCallsHandle(client, "s1");
    const unsub = handle.route({
      get_weather: (input, ctx) => {
        seenInput.push({ input, ctx });
        return [{ type: "text", text: "sunny" }];
      },
    });

    stream.emit(toolCall("get_weather", { city: "SF" }), "corr:1");
    await waitFor(() => seen.length === 1);

    expect(seen[0]!.method).toBe("session/respond_to_tool_call");
    expect(seen[0]!.params).toEqual({
      sessionId: "s1",
      correlationId: "corr:1",
      result: [{ type: "text", text: "sunny" }],
    });
    expect(seenInput).toEqual([
      { input: { city: "SF" }, ctx: { toolCallId: "tc-1", name: "get_weather" } },
    ]);

    // Routing's Unsubscribe stops dispatch; the handle owns the subscription.
    unsub();
    expect(stream.isClosed).toBe(false);
    handle.close();
    expect(stream.isClosed).toBe(true);
  });

  it("an unknown tool relays the default error result", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const handle = clientToolCallsHandle(client, "s1");
    handle.route({});

    stream.emit(toolCall("mystery", {}), "corr:2");
    await waitFor(() => seen.length === 1);

    const params = seen[0]!.params as { result: { content: string; isError: boolean } };
    expect(params.result).toEqual({ content: 'no client handler for "mystery"', isError: true });
    handle.close();
  });

  it("a handler THROW relays an error result — the call is never left hanging", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const handle = clientToolCallsHandle(client, "s1");
    handle.route({
      boom: () => {
        throw new Error("kaboom");
      },
    });

    stream.emit(toolCall("boom", {}), "corr:3");
    await waitFor(() => seen.length === 1);

    const params = seen[0]!.params as { result: { content: string; isError: boolean } };
    expect(params.result).toEqual({ content: "kaboom", isError: true });
    handle.close();
  });

  it("a custom opts.onUnknown overrides the default", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const handle = clientToolCallsHandle(client, "s1");
    handle.route({}, { onUnknown: (_input, ctx) => `handled ${ctx.name} by fallback` });

    stream.emit(toolCall("whatever", {}), "corr:4");
    await waitFor(() => seen.length === 1);

    const params = seen[0]!.params as { result: unknown };
    expect(params.result).toBe("handled whatever by fallback");
    handle.close();
  });
});

describe("clientToolCalls.route — fire-and-forget relays", () => {
  it("dispatches the handler but sends NO respond, and never enters list()", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    let ran = 0;

    const handle = clientToolCallsHandle(client, "s1");
    handle.route({
      notify_ui: () => {
        ran++;
        return [{ type: "text", text: "rendered" }];
      },
    });

    // NO correlationId → one-way notify.
    stream.emit(toolCall("notify_ui", { badge: 1 }));
    await waitFor(() => ran === 1);

    // Give any erroneous respond a chance to land, then assert none did.
    await Promise.resolve();
    expect(seen).toHaveLength(0);
    expect(handle.list()).toHaveLength(0); // fire-and-forget is not pending
    handle.close();
  });
});
