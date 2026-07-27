/**
 * The `events()` completion marker, end to end.
 *
 * A progress token's stream is BOUNDED — it lives for exactly one
 * `session/send`. Without a terminal frame the client cannot tell "no more
 * events" from "nothing yet": `events()` hangs on the last `next()`, and the
 * token's registration in the transport's `progressStreams` map is never
 * reaped. Both are fixed by one frame — `notifications/progress/complete`,
 * sent by the gateway AFTER both progress fan-outs drain.
 *
 * The load-bearing ordering is asserted twice over:
 *
 *   - the marker arrives after the LAST execution event, not racing it;
 *   - a deliberately slow consumer still receives every frame — the marker
 *     terminates the stream but the buffered tail drains first.
 *
 * Full stack, no fakes on the wire path: real client → in-process transport
 * → real gateway → real app → real session → real loop.
 */

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  jsonSchema,
  type ContentBlock,
  type ExecutionTarget,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type StreamEvent,
  type ToolHandler,
  type ToolRegistration,
} from "@agentick/spec";
import { dispatchRequest, type DispatchSink } from "@agentick/transport";

import { inProcessTransport } from "../index.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

function toolRegistration(): ToolRegistration {
  return {
    declaration: {
      id: "do_work",
      name: "do_work",
      description: "does a unit of work",
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      exposure: ["model", "dispatch"],
      annotations: { displaySummary: "Doing the work" },
    },
    handlerRef: "handlers/do_work",
    binding: { scope: "runtime" },
  };
}

const doWorkHandler: ToolHandler = () => {
  const content: ContentBlock[] = [{ type: "text", text: "done" }];
  return content;
};

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();

  const executor = new FakeLanguageModelExecutor("done-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [
            { type: "tool_use", toolUseId: "tc-1", name: "do_work", input: {} } as ContentBlock,
          ],
          stopReason: "tool_use",
          toolCalls: [{ id: "tc-1", name: "do_work", input: {} }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "all done" } satisfies ContentBlock],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "done-app",
    rootElement: null,
    options: {
      modelExecutor: executor,
      compiler: fakeCompiler(),
      target,
      inheritedTools: [toolRegistration()],
      toolHandlers: new Map<string, ToolHandler>([["handlers/do_work", doWorkHandler]]),
    },
  });
  const session = await app.createSession({ sessionId: "done-session" });

  let sinkForwarder: ((n: { method: string; params?: unknown }) => void) | undefined;
  const sink: DispatchSink = {
    sendNotification: (n) => sinkForwarder?.(n),
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: (_id: JsonRpcId, _abort: () => void) => {},
    unregisterInFlight: () => {},
  };

  const handler = async (
    req: JsonRpcRequest,
    sendNotification: (n: { method: string; params?: unknown }) => void,
  ): Promise<JsonRpcResponse> => {
    sinkForwarder = sendNotification;
    return dispatchRequest(gateway, req, sink);
  };

  const client = await createClient({ transport: inProcessTransport({ handler }) });
  await client.connect();

  return {
    client,
    sessionId: session.id,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("events() completion marker", () => {
  it("the client handle's events() iterator COMPLETES on its own after the send settles", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    const handle = await client.session(sessionId).send({
      messages: [{ role: "user", content: "go" }],
    });

    // No timeout, no manual close: if the marker never arrives this hangs and
    // the test fails on the suite timeout.
    const events: StreamEvent[] = [];
    for await (const event of handle.events()) events.push(event);

    // The stream ended AFTER the terminal `result` event — completion is not
    // an early truncation.
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe("result");

    await handle.result;
    await cleanup();
  });

  it("drops no tail frame under a deliberately slow consumer", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    const handle = await client.session(sessionId).send({
      messages: [{ role: "user", content: "go" }],
    });

    // A consumer slow enough that the whole run — marker included — is
    // already queued before the first frames are read. The marker must
    // terminate the stream WITHOUT discarding the buffered tail.
    const events: StreamEvent[] = [];
    for await (const event of handle.events()) {
      await new Promise((r) => setTimeout(r, 5));
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("result");
    // The full execution shape survived, not just the head of the stream.
    const types = events.map((e) => e.type);
    expect(types).toContain("execution-start");
    expect(types).toContain("tool-dispatch");
    expect(types).toContain("execution-end");

    await handle.result;
    await cleanup();
  });

  it("reaps the token registration so a completed send leaks nothing", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    // The registry is transport-internal; read it through the same door the
    // routing code uses so the assertion tracks the real map.
    const registry = (
      client.transport as unknown as { readonly progressStreams: Map<string, unknown> }
    ).progressStreams;

    const handle = await client.session(sessionId).send({
      messages: [{ role: "user", content: "go" }],
    });
    for await (const _event of handle.events()) {
      /* drain */
    }
    await handle.result;

    expect(registry.size).toBe(0);

    await cleanup();
  });

  it("carries the resolved displaySummary to the client on tool-dispatch", async () => {
    const { client, sessionId, cleanup } = await makeStack();
    const handle = await client.session(sessionId).send({
      messages: [{ role: "user", content: "go" }],
    });
    const events: StreamEvent[] = [];
    for await (const event of handle.events()) events.push(event);
    await handle.result;

    const dispatched = events.find((e) => e.type === "tool-dispatch");
    expect(dispatched).toBeDefined();
    expect((dispatched as { presentation?: { summary?: string } }).presentation).toMatchObject({
      name: "do_work",
      summary: "Doing the work",
    });

    await cleanup();
  });
});
