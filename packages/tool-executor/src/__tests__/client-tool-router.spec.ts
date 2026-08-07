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
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { TOOL_CALL_CHANNEL_FQN } from "../tool-call-schema.js";
import { clientToolCallsHandle, type ClientToolCallsClient } from "../client/client-tool-calls.js";
import { createClientTool } from "../client/create-client-tool.js";

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

/** A relay ADDRESSED to a specific client. */
function toolCallFor(name: string, input: unknown, target: string): unknown {
  return { toolCallId: "tc-1", name, input, target };
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

describe("clientToolCalls.use — declare and route as one act", () => {
  it("publishes the projected declarations, then answers a call with the same object's handler", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const handle = clientToolCallsHandle(client, "s1");

    await handle.use([
      createClientTool({
        name: "read_selection",
        description: "What the user has highlighted",
        inputSchema: jsonSchema({ type: "object" }),
        handler: async () => [{ type: "text", text: "highlighted" }],
      }),
    ] as never);

    // The declaration is a PROJECTION — the handler never reaches the wire.
    const declare = seen.find((r) => r.method === "session/set_client_tools");
    expect(declare).toBeDefined();
    const declarations = (declare!.params as { declarations: readonly object[] }).declarations;
    expect(declarations).toEqual([
      {
        name: "read_selection",
        description: "What the user has highlighted",
        inputSchema: { type: "object" },
      },
    ]);

    stream.emit(toolCall("read_selection", {}), "corr:use");

    await waitFor(() => seen.some((r) => r.method === "session/respond_to_tool_call"));
    const reply = seen.find((r) => r.method === "session/respond_to_tool_call");
    expect((reply!.params as { result: unknown }).result).toEqual([
      { type: "text", text: "highlighted" },
    ]);
    handle.close();
  });

  it("a declined call is left UNANSWERED — another attached client is expected to take it", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const handle = clientToolCallsHandle(client, "s1");

    await handle.use([
      createClientTool({
        name: "navigate_to",
        description: "d",
        inputSchema: jsonSchema({ type: "object" }),
        handler: async () => "navigated",
      }),
      createClientTool({
        name: "show_toast",
        description: "d",
        inputSchema: jsonSchema({ type: "object" }),
        handler: async () => "shown",
      }),
    ] as never);

    // The decline goes FIRST, then an accepted call. Waiting for the second
    // reply proves the first had its chance and took it — a bare "nothing was
    // sent yet" would pass before any dispatch ran at all.
    stream.emit(toolCallFor("navigate_to", {}, "someone-else"), "corr:decline");
    stream.emit(toolCall("show_toast", {}), "corr:accept");

    await waitFor(() => seen.some((r) => r.method === "session/respond_to_tool_call"));
    const replies = seen.filter((r) => r.method === "session/respond_to_tool_call");
    expect(replies).toHaveLength(1);
    expect((replies[0]!.params as { correlationId: string }).correlationId).toBe("corr:accept");
    handle.close();
  });

  it("still answers a tool it does not know — silence there would hang the call", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const handle = clientToolCallsHandle(client, "s1");

    await handle.use([] as never);
    stream.emit(toolCall("mystery", {}), "corr:unknown");

    await waitFor(() => seen.some((r) => r.method === "session/respond_to_tool_call"));
    expect((seen.at(-1)!.params as { result: unknown }).result).toEqual({
      content: 'no client handler for "mystery"',
      isError: true,
    });
    handle.close();
  });
});

describe("clientToolCalls.use — teardown", () => {
  it("closing the handle stops routing, so the returned stop() is optional", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const handle = clientToolCallsHandle(client, "s1");

    // Deliberately DISCARD the returned unsubscribe — the common case is tools
    // that live as long as the page.
    await handle.use([
      createClientTool({
        name: "t",
        description: "d",
        inputSchema: jsonSchema({ type: "object" }),
        handler: async () => "ran",
      }),
    ] as never);

    handle.close();
    stream.emit(toolCall("t", {}), "corr:after-close");

    await waitFor(() => stream.isClosed);
    expect(seen.some((r) => r.method === "session/respond_to_tool_call")).toBe(false);
  });

  it("aborts the handlers' signal on close, so a tool mid-await can bail", async () => {
    const stream = pushStream();
    const { client } = stubClient(stream);
    const handle = clientToolCallsHandle(client, "s1");

    let aborted: boolean | undefined;
    await handle.use([
      createClientTool({
        name: "t",
        description: "d",
        inputSchema: jsonSchema({ type: "object" }),
        handler: async (_i, ctx) => {
          ctx.signal.addEventListener("abort", () => void (aborted = true));
          return "ran";
        },
      }),
    ] as never);

    stream.emit(toolCall("t", {}), "corr:1");
    await waitFor(() => handle.list().length === 0);
    handle.close();

    expect(aborted).toBe(true);
  });

  it("the returned stop() ends routing while the handle stays open for a new set", async () => {
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const handle = clientToolCallsHandle(client, "s1");

    const tool = (text: string) =>
      createClientTool({
        name: "t",
        description: "d",
        inputSchema: jsonSchema({ type: "object" }),
        handler: async () => text,
      });

    const stop = await handle.use([tool("first")] as never);
    stop();
    await handle.use([tool("second")] as never);

    stream.emit(toolCall("t", {}), "corr:1");

    await waitFor(() => seen.some((r) => r.method === "session/respond_to_tool_call"));
    const replies = seen.filter((r) => r.method === "session/respond_to_tool_call");
    expect(replies).toHaveLength(1);
    expect((replies[0]!.params as { result: unknown }).result).toBe("second");
    handle.close();
  });
});

describe("addressing is a property of the FEED, not of one dispatch path", () => {
  /** A client whose bound id the handle will read as its own. */
  function clientWithId(stream: SubscriptionStream, id: string) {
    const { client, seen } = stubClient(stream);
    return { client: { ...client, runtime: { clientId: id } }, seen };
  }

  it("route() ignores a call addressed to another client", async () => {
    // `route` predates addressing. Left ungated it reproduces the original
    // defect exactly — four tabs, four navigations — in a public API.
    const stream = pushStream();
    const { client, seen } = clientWithId(stream, "client-A");
    const handle = clientToolCallsHandle(client as never, "s1");
    const ran: unknown[] = [];

    handle.route({ navigate_to: (input) => (ran.push(input), "navigated") });
    stream.emit(toolCallFor("navigate_to", {}, "client-B"), "corr:other");
    stream.emit(toolCall("ping", {}), "corr:mine");

    await waitFor(() => seen.some((r) => r.method === "session/respond_to_tool_call"));
    expect(ran).toHaveLength(0);
    handle.close();
  });

  it("route() runs a call addressed to THIS client", async () => {
    const stream = pushStream();
    const { client, seen } = clientWithId(stream, "client-A");
    const handle = clientToolCallsHandle(client as never, "s1");

    handle.route({ navigate_to: () => "navigated" });
    stream.emit(toolCallFor("navigate_to", {}, "client-A"), "corr:mine");

    await waitFor(() => seen.some((r) => r.method === "session/respond_to_tool_call"));
    expect((seen.at(-1)!.params as { result: unknown }).result).toBe("navigated");
    handle.close();
  });

  it("list() omits a call addressed elsewhere — its .respond would steal the work", async () => {
    const stream = pushStream();
    const { client } = clientWithId(stream, "client-A");
    const handle = clientToolCallsHandle(client as never, "s1");

    stream.emit(toolCallFor("navigate_to", {}, "client-B"), "corr:other");
    stream.emit(toolCallFor("navigate_to", {}, "client-A"), "corr:mine");

    await waitFor(() => handle.list().length > 0);
    expect(handle.list().map((c) => c.correlationId)).toEqual(["corr:mine"]);
    handle.close();
  });
});

describe("a call outstanding across a reconnect", () => {
  it("is LISTED for the client that owns it, not re-dispatched", async () => {
    // The snapshot exists so a client that reconnects mid-call can see and
    // answer the call rather than have it hang. It is deliberately not
    // re-dispatched: the handler may already have run before the socket
    // dropped, and nothing here can tell. The app decides.
    const stream = pushStream();
    const { client, seen } = stubClient(stream);
    const handle = clientToolCallsHandle(client, "s1");
    const ran: unknown[] = [];

    handle.route({ resume_me: (input) => (ran.push(input), "resumed") });
    stream.emit({
      kind: "snapshot",
      requests: [
        {
          correlationId: "corr:outstanding",
          replyTo: "inbox",
          payload: { toolCallId: "tc-outstanding", name: "resume_me", input: { x: 1 } },
        },
      ],
    });

    await waitFor(() => handle.list().length === 1);
    expect(ran).toHaveLength(0);
    expect(seen.some((r) => r.method === "session/respond_to_tool_call")).toBe(false);

    // …and answering it from the list round-trips like a live one.
    await handle.list()[0]!.respond("resumed by hand");
    expect((seen.at(-1)!.params as { result: unknown }).result).toBe("resumed by hand");
    handle.close();
  });

  it("omits one addressed to a different client", async () => {
    const stream = pushStream();
    const { client } = stubClient(stream);
    const handle = clientToolCallsHandle(
      { ...client, runtime: { clientId: "client-A" } } as never,
      "s1",
    );

    stream.emit({
      kind: "snapshot",
      requests: [
        {
          correlationId: "corr:theirs",
          replyTo: "inbox",
          payload: { toolCallId: "tc-1", name: "t", input: {}, target: "client-B" },
        },
        {
          correlationId: "corr:mine",
          replyTo: "inbox",
          payload: { toolCallId: "tc-2", name: "t", input: {}, target: "client-A" },
        },
      ],
    });

    await waitFor(() => handle.list().length > 0);
    expect(handle.list().map((c) => c.correlationId)).toEqual(["corr:mine"]);
    handle.close();
  });
});
