/**
 * Full-stack `session.tools` round-trip — the client `ToolsClientHandle` over
 * the real wire (three-audiences-plan §F).
 *
 * Unlike gates (the generic dynamic-command lane), `tools` enumeration rides a
 * DEDICATED session-namespace wire read, `session/list_tools` — the tool
 * executor's `tool:<sessionId>` inbox address does not fit the dynamic lane's
 * `<surface>:<sessionId>:<surface>` pattern, so a gateway-resident handler over
 * `sess.tools.list(query)` carries it (mirroring `session/set_client_tools`).
 * This drives that read through the REAL `GatewayHarness` + `inProcessTransport`
 * via the client `session.tools` handle (ADR 87).
 *
 * Side-effect import of `@agentick/tool-executor/client` registers the
 * client `session.tools` sub-handle (distinct from `clientToolCalls`).
 */

import "@agentick/tool-executor/client";

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { jsonSchema, type ToolDeclaration } from "@agentick/spec";

import { inProcessTransport } from "../index.js";

const SCHEMA = { type: "object", properties: { q: { type: "string" } } } as const;

const modelTool: ToolDeclaration = {
  id: "search",
  name: "search",
  description: "search the corpus",
  inputSchema: jsonSchema(SCHEMA),
  exposure: ["model"],
};
const dispatchTool: ToolDeclaration = {
  id: "admin_reset",
  name: "admin_reset",
  description: "host-only reset",
  inputSchema: jsonSchema(SCHEMA),
  exposure: ["dispatch"],
};

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-tools-exec", journal, bus, inbox, {
    scripted: [],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "tools-app",
    rootElement: null,
    options: { modelExecutor: executor, compiler: fakeCompiler() },
  });
  const session = await app.createSession({
    sessionId: "tools-session",
    tools: [modelTool, dispatchTool],
  });

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
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

describe("tools end-to-end — client ↔ gateway ↔ session (session/list_tools)", () => {
  it("tools.refresh() round-trips the server registry as wire-safe ToolInfo", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    const tools = client.session(sessionId).tools;
    const rows = await tools.refresh();

    const byName = new Map(rows.map((t) => [t.name, t]));
    expect(byName.get("search")).toMatchObject({
      name: "search",
      exposure: ["model"],
      hasInputSchema: true,
    });
    expect(byName.get("admin_reset")).toMatchObject({
      name: "admin_reset",
      exposure: ["dispatch"],
    });
    // Wire-safe projection — the live StandardSchema validator never crosses.
    expect("inputSchema" in byName.get("search")!).toBe(false);

    // The Enumerable snapshot is populated after the poll.
    expect(tools.get("search")?.name).toBe("search");

    await cleanup();
  });

  it("tools.refresh({ exposure }) filters over the wire", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    const tools = client.session(sessionId).tools;
    const dispatchOnly = await tools.refresh({ exposure: "dispatch" });
    expect(dispatchOnly.map((t) => t.name)).toEqual(["admin_reset"]);

    const modelOnly = await tools.refresh({ exposure: "model" });
    expect(modelOnly.map((t) => t.name)).toEqual(["search"]);

    await cleanup();
  });
});
