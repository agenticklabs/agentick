/**
 * The connect/close pairing for IN-PROCESS MCP connections, pinned at the
 * server's own ledger. The v2 server has no idle TTL — cleanup is exclusively
 * close-driven (`transport.onclose`) — so a host that connects per session
 * (knowify's shape: a `transport` factory over `inMemoryServerTransport().connect()`)
 * leaks server-side connection state unless EVERY session teardown path closes
 * its client. The chain under test: session evict/close → session-scoped
 * `withMCP` onClose → client harness teardown → SDK client close → in-memory
 * peer close → server `_removeConnection`.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "@agentick/app/react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { ExecutionTarget } from "@agentick/spec";

import { withMCP } from "../index.js";
import { NoneAuth } from "../client/index.js";
import { inMemoryServerTransport, McpServerHarness } from "../server/index.js";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

const mkTarget = (): ExecutionTarget =>
  ({ kind: "language-model", provider: "fake", modelId: "m", capabilities: {} }) as ExecutionTarget;

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    `exec:${generateId()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text" as const, text: "ok" }],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

async function mkServer(): Promise<{
  harness: McpServerHarness;
  transport: ReturnType<typeof inMemoryServerTransport>;
}> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { name: "lifecycle", transports: [transport], serverInfo: { name: "t", version: "0.0.0" } },
  );
  await harness.ready;
  await harness.start();
  return { harness, transport };
}

describe("withMCP — in-process connection lifecycle", () => {
  it("evicting and closing sessions removes their server-side connections", async () => {
    const { harness, transport } = await mkServer();

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      target: mkTarget(),
      extensions: [
        withMCP({
          servers: [
            {
              serverId: "lifecycle",
              // knowify's production shape: a fresh in-process connection per
              // session construction — including every rehydrate.
              transport: async () => await transport.connect(),
              auth: new NoneAuth(),
            },
          ],
        }),
      ],
    });

    await app.createSession({ sessionId: "s-A" });
    const b = await app.createSession({ sessionId: "s-B" });
    expect(harness.connections()).toHaveLength(2);

    // Eviction is a page-out, not an ending — but its MCP connection must die.
    await app.evictSession("s-A");
    expect(harness.connections()).toHaveLength(1);

    // Rehydrating opens a fresh connection: a hibernate→wake cycle nets zero.
    await app.createSession({ sessionId: "s-A" });
    expect(harness.connections()).toHaveLength(2);
    await app.evictSession("s-A");
    expect(harness.connections()).toHaveLength(1);

    await b.close();
    expect(harness.connections()).toHaveLength(0);

    await app.closeApp();
    await harness.close();
  });
});
