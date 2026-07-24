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

import { createClient } from "@agentick/client-core-next";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { createGateway } from "@agentick/gateway-next";
import { fakeCompiler } from "@agentick/compiler-next/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
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
} from "@agentick/spec-next";
import { dispatchRequest, type DispatchSink } from "@agentick/transport-next";

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
  const session = await app.createSession({ sessionId: "test-session" });

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

  it("exposes the right session/app via gateway methods", async () => {
    const { client, appId, sessionId, cleanup } = await makeStack("ok");

    const { apps } = await client.gateway().listApps();
    expect(apps.map((a) => a.id)).toContain(appId);

    const sessions = await client.app(appId).listSessions();
    expect(sessions.map((s) => s.id)).toContain(sessionId);

    await cleanup();
  });
});
