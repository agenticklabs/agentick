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

import { createClient } from "@agentick/client-next";
import { MockLanguageModelExecutor } from "@agentick/executor-next";
import { createGateway } from "@agentick/gateway-next";
import { defineReconciler } from "@agentick/reconciler-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import {
  type ContentBlock,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RenderTreeResult,
} from "@agentick/spec-next";
import { dispatchRequest, type DispatchSink } from "@agentick/transport-next";

import { inProcessTransport } from "../index.js";

/**
 * Stub reconciler — produces an empty IR. The MockLanguageModelExecutor
 * ignores the prompt and returns scripted output, so the actual tree
 * doesn't matter here. Keeps the test free of any specific JSX runtime
 * dep (React, etc.).
 */
function stubReconciler() {
  return defineReconciler({
    mount: async () => ({ mountId: "stub" }),
    unmount: async () => {},
    renderTree: async ({ mountId }) =>
      ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tree: { context: { entries: [] }, declarations: {} } as any,
        diagnostics: { warnings: [], errors: [] },
        version: 1,
        mountId,
      }) satisfies RenderTreeResult,
  });
}

async function makeStack(replyText: string) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new MockLanguageModelExecutor("e2e-exec", journal, bus, inbox, {
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

  const gateway = await createGateway();
  const app = await gateway.createApp({
    appId: "test-app",
    rootElement: null,
    options: { executor, reconciler: stubReconciler() },
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

  it("exposes the right session/app via gateway methods", async () => {
    const { client, appId, sessionId, cleanup } = await makeStack("ok");

    const { apps } = await client.gateway().listApps();
    expect(apps.map((a) => a.id)).toContain(appId);

    const sessions = await client.app(appId).listSessions();
    expect(sessions.map((s) => s.id)).toContain(sessionId);

    await cleanup();
  });
});
