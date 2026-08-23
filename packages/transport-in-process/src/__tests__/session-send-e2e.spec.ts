/**
 * Full-stack `session/send` integration — client → in-process transport
 * → gateway → app → session → executor → response back through the
 * wire. Verifies the wire shape + dispatch + executor wiring all hold
 * together; previous tests stubbed the gateway handler with a switch.
 *
 * 33.C hardening — closes the "real session/send end-to-end test"
 * follow-up flagged in STATUS.
 */

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  type ContentBlock,
  type ExecutorFx,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type LanguageModelExecutionResult,
  type LanguageModelInput,
  type ResponseFormat,
  type SessionSendParams,
  SessionNotFoundError,
} from "@agentick/spec";
import { dispatchRequest, type DispatchSink } from "@agentick/transport";

import { inProcessTransport } from "../index.js";

async function makeStack(replyText: string) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: replyText } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  // Capture the `responseFormat` the executor sees on each tick's projected
  // input — the loop overlays `SendInput.responseFormat` onto the compiled
  // `config` before projecting, so this is where a wire-declared directive
  // lands after crossing the transport.
  const seenResponseFormats: (ResponseFormat | undefined)[] = [];
  const baseFx = executor.fx;
  const patchedFx: ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> = {
    ...baseFx,
    project: (input) => {
      seenResponseFormats.push(input.compiled?.config?.responseFormat);
      return baseFx.project(input);
    },
    run: (input) => {
      seenResponseFormats.push(input.compiled?.config?.responseFormat);
      return baseFx.run(input);
    },
  };
  Object.defineProperty(executor, "fx", { configurable: true, get: () => patchedFx });

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "test-app",
    rootElement: null,
    options: { modelExecutor: executor, compiler: fakeCompiler() },
  });
  // `eager` so the durable record is enumerable immediately (the "exposes the
  // right session" test lists it without a prior send; lazy genesis otherwise
  // defers the write to the first mutation).
  const session = await app.createSession({ sessionId: "test-session", eager: true });

  // Minimal DispatchSink — no subscription / in-flight tracking
  // exercised in this test; sendNotification routed into the transport.
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
    appId: app.id,
    seenResponseFormats,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("session/send — full client → gateway → executor roundtrip", () => {
  it("delivers the executor's scripted reply through the wire", async () => {
    const { client, sessionId, cleanup } = await makeStack("hello back");

    const result = await client
      .session(sessionId)
      .send({ messages: [{ role: "user", content: "ping" }] }).result;

    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toMatchObject({ type: "text", text: "hello back" });
    expect(result.stopReason).toBe("end");

    await cleanup();
  });

  it("threads a declarative responseFormat across the wire to the executor (trail-response-format-send)", async () => {
    const { client, sessionId, seenResponseFormats, cleanup } = await makeStack("ok");

    const responseFormat: ResponseFormat = {
      type: "json_schema",
      name: "wire-response",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
    };

    await client
      .session(sessionId)
      .send({ messages: [{ role: "user", content: "ping" }], responseFormat }).result;

    // The declarative directive crossed client → wire → gateway → session →
    // loop overlay → executor projection.
    expect(seenResponseFormats).toHaveLength(1);
    expect(seenResponseFormats[0]?.type).toBe("json_schema");
    expect(seenResponseFormats[0]).toMatchObject({ name: "wire-response" });

    await cleanup();
  });

  it("threads onBusy across the wire (busy-send behavior is a JSON-clean enum)", async () => {
    const { client, sessionId, cleanup } = await makeStack("queued reply");

    // `onBusy` is a JSON-clean string enum on SessionSendParams — it crosses
    // client → wire → gateway → session. On an idle session `"queue"` behaves
    // identically to a normal send (fresh execution), so the reply delivers.
    const params: SessionSendParams = {
      sessionId,
      messages: [{ role: "user", content: "ping" }],
      onBusy: "queue",
    };
    expect(params.onBusy).toBe("queue");

    const result = await client
      .session(sessionId)
      .send({ messages: [{ role: "user", content: "ping" }], onBusy: "queue" }).result;

    expect(result.output[0]).toMatchObject({ type: "text", text: "queued reply" });
    expect(result.stopReason).toBe("end");

    await cleanup();
  });

  it("SessionSendParams is declare-only for structured output — no live `output` field crosses", () => {
    // Type-level: the wire params carry `responseFormat` (serializable) but
    // NOT the live `output` Standard Schema. A schema cannot cross the wire.
    const params: SessionSendParams = {
      sessionId: "s",
      responseFormat: { type: "json" },
    };
    expect(params.responseFormat).toBeDefined();
    // @ts-expect-error — `output` is deliberately absent from the wire shape.
    const bad: SessionSendParams = { sessionId: "s", output: {} };
    void bad;
  });

  it("a server-thrown AgentickError rehydrates typed on the client (G2-wire-errors)", async () => {
    const { client, cleanup } = await makeStack("unused");

    // `session/dispatch` throws SessionNotFoundError for an unknown session —
    // work asked of a session that does not exist, which (unlike `send`, the
    // one existence-creating verb) is still an error. The server dispatch
    // stamps its toJSON() into JSON-RPC error.data, and the client rehydrates
    // it via spec's codec — SAME class, instanceof holds across the wire,
    // fields intact.
    const caught = await client
      .request("session/dispatch", {
        sessionId: "no-such-session",
        tool: "anything",
        input: {},
      })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(SessionNotFoundError);
    const e = caught as SessionNotFoundError;
    expect(e._tag).toBe("SessionNotFoundError");
    expect(e.sessionId).toBe("no-such-session");

    await cleanup();
  });

  it("exposes the right session/app via gateway methods", async () => {
    const { client, appId, sessionId, cleanup } = await makeStack("ok");

    const { apps } = await client.gateway().listApps();
    expect(apps.map((a) => a.id)).toContain(appId);

    const { sessions } = await client.app(appId).listSessions();
    expect(sessions.map((s) => s.id)).toContain(sessionId);

    await cleanup();
  });
});
