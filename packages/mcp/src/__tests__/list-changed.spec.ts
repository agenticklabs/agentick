/**
 * `notifications/tools/list_changed` reactivity — the MCP client
 * handles server-emitted catalog-change notifications and re-runs
 * tool discovery so sessions see the fresh tool set.
 *
 * Ticket #309. Covers the loop:
 *
 *   MCP server changes tools → server calls `sendToolListChanged()` →
 *   client receives notification → `McpClientHarness.onListChanged` fires →
 *   `withMCP` tears down previous registrations + re-runs
 *   `discoverAndRegisterTools` → session sees the new tool set.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "@agentick/app/react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { waitFor } from "@agentick/utils/testing";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { InMemoryMcpTransport, NoneAuth, withMCP } from "../index.js";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "list-changed-exec",
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

/**
 * Build an MCP server backed by a mutable tools reference. Callers
 * mutate the array + call `notifyChange()` to fire
 * `notifications/tools/list_changed` on the wire.
 */
async function mkMutableServer(): Promise<{
  readonly server: Server;
  readonly clientTransport: InMemoryMcpTransport;
  readonly setTools: (tools: readonly Tool[]) => void;
  readonly notifyChange: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  let currentTools: readonly Tool[] = [];

  const server = new Server(
    { name: "mutable-mcp-server", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...currentTools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = currentTools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `unknown tool ${req.params.name}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `${tool.name} ok` }],
    };
  });

  await server.connect(serverTransport);

  return {
    server,
    clientTransport,
    setTools: (tools) => {
      currentTools = tools;
    },
    notifyChange: () => server.sendToolListChanged(),
  };
}

const initialTool: Tool = {
  name: "before",
  description: "the initial tool",
  inputSchema: { type: "object", properties: {} },
};

const replacementTool: Tool = {
  name: "after",
  description: "the tool that appears after the server pushes list_changed",
  inputSchema: { type: "object", properties: {} },
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("withMCP — notifications/tools/list_changed reactivity", () => {
  it("re-discovers tools when the server emits list_changed", async () => {
    const { server, clientTransport, setTools, notifyChange } = await mkMutableServer();
    setTools([initialTool]);

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [
            {
              serverId: "srv",
              transport: clientTransport,
              auth: new NoneAuth(),
            },
          ],
        }),
      ],
    });
    const session = await app.createSession();

    // Baseline — initial tool is dispatchable.
    const before = await session.tools.dispatch("srv__before", {});
    expect(before).toEqual([{ type: "text", text: "before ok" }]);

    // Swap the server's tool catalog + push the notification. The
    // client's onListChanged handler tears down the old registration
    // and re-runs discoverAndRegisterTools; the session's tool set
    // reflects the new catalog after re-discovery completes.
    setTools([replacementTool]);
    await notifyChange();

    // Poll for the new tool being dispatchable — re-discovery runs
    // asynchronously on the notification handler.
    await waitFor(
      async () => {
        try {
          const result = await session.tools.dispatch("srv__after", {});
          return result[0]?.type === "text" && result[0].text === "after ok";
        } catch {
          return false;
        }
      },
      { timeoutMs: 1000, pollMs: 20 },
    );

    // Sanity: the old tool is gone (dispatching it now fails to
    // resolve a handler on the ToolExecutor).
    await expect(session.tools.dispatch("srv__before", {})).rejects.toBeDefined();

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("harness.onListChanged fires for prompts/resources notifications too", async () => {
    // withMCP projects tools + resources; prompts is still harness-layer
    // only. Regardless, the harness fans out all three notification
    // kinds — adopters watching at the harness layer see uniform
    // coverage independent of what withMCP surfaces.
    const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
    const server = new Server(
      { name: "notifier-mcp-server", version: "1.0.0" },
      {
        capabilities: {
          tools: { listChanged: true },
          prompts: { listChanged: true },
          resources: { listChanged: true },
        },
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    await server.connect(serverTransport);

    const observed: string[] = [];

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [
            {
              serverId: "signal-only",
              transport: clientTransport,
              auth: new NoneAuth(),
            },
          ],
        }),
      ],
    });
    const session = await app.createSession();

    // Reach the underlying harness via `session.bridges.mcp` — the
    // namespace withMCP registers via `installer.registerNamespace`.
    const bridges = (
      session as unknown as {
        readonly bridges: {
          readonly mcp?: {
            client: (
              id: string,
            ) => { onListChanged: (l: (e: { kind: string }) => void) => () => void } | undefined;
          };
        };
      }
    ).bridges;
    const harness = bridges.mcp?.client("signal-only");
    if (!harness) throw new Error("expected mcp bridge to expose the harness");
    const unsub = harness.onListChanged((event) => {
      observed.push(event.kind);
    });

    await server.sendToolListChanged();
    await server.sendPromptListChanged();
    await server.sendResourceListChanged();

    await waitFor(() => observed.length === 3, { timeoutMs: 1000, pollMs: 10 });
    expect(new Set(observed)).toEqual(new Set(["tools", "prompts", "resources"]));

    unsub();
    await session.close();
    await app.closeApp();
    await server.close();
  });
});
