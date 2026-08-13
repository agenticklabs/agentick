/**
 * Full-stack resources round-trip — sanity net over the real wire.
 *
 * `ResourcesHarness` declares `resources:read` / `resources:list` /
 * `resources:listTemplates` with `exposure: "wire"`, and the dynamic-command
 * lane routes them because the surface is MOUNTED — the ask to
 * `resources:<sid>:resources` lands on a live handler (#258 dropped the
 * addressing allowlist; reachability is now the inbox's call). This test drives
 * them end-to-end through the REAL `GatewayHarness` + `inProcessTransport` (no
 * client resources handle in this PR — the calls go straight through
 * `client.transport.request`).
 */

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ErrorCode, type ContentBlock, type WireMethod } from "@agentick/spec";

import { inProcessTransport } from "../index.js";

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-res-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "res-app",
    rootElement: null,
    options: { modelExecutor: executor, compiler: fakeCompiler() },
  });
  const session = await app.createSession({ sessionId: "res-session" });

  // A fixed resource + a template on the session's ResourcesHarness.
  session.resources.register("test://doc", (uri) => [
    { uri, text: "hello world", mimeType: "text/plain" },
  ]);
  session.resources.registerTemplate("test://items/{id}", (uri) => [{ uri, text: "item" }]);

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();

  const request = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    client.transport.request(method as WireMethod, params as never);

  return {
    request,
    sessionId: session.id,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("resources end-to-end — client ↔ gateway (dynamic lane) ↔ session", () => {
  it("resources/read round-trips the resolver's content", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    const contents = (await request("resources/read", {
      sessionId,
      uri: "test://doc",
    })) as ReadonlyArray<{ uri: string; text?: string }>;

    expect(contents[0]).toMatchObject({ uri: "test://doc", text: "hello world" });

    await cleanup();
  });

  it("resources/list enumerates the fixed resource", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    const reply = (await request("resources/list", { sessionId })) as {
      resources: ReadonlyArray<{ uri: string }>;
    };

    expect(reply.resources.some((r) => r.uri === "test://doc")).toBe(true);

    await cleanup();
  });

  it("resources/listTemplates enumerates the template", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    const reply = (await request("resources/listTemplates", { sessionId })) as {
      templates: ReadonlyArray<{ uriTemplate: string }>;
    };

    expect(reply.templates.some((t) => t.uriTemplate === "test://items/{id}")).toBe(true);

    await cleanup();
  });

  it("commands/list enumerates the wire-exposed resources verbs", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    const reply = (await request("commands/list", { sessionId })) as {
      commands: Array<{ method: string }>;
    };
    const methods = reply.commands.map((c) => c.method);
    for (const m of ["resources/read", "resources/list", "resources/listTemplates"]) {
      expect(methods).toContain(m);
    }

    await cleanup();
  });

  it("an undeclared resources verb is MethodNotFound (deny-by-default)", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    const err = await request("resources/delete", { sessionId }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    // Canonical TransportError shape: `{ kind: "rpc", error: { code: -32601 } }`.
    const e = err as { code?: number; error?: { code?: number } };
    expect(e.error?.code ?? e.code).toBe(ErrorCode.MethodNotFound);

    await cleanup();
  });
});
