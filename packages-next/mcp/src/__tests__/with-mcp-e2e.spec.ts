/**
 * `withMCP` end-to-end — closes the loop from agent dispatch to MCP
 * server and back through the real AppHarness extension lifecycle.
 *
 *   1. SDK Server with two tools (`echo`, `add`) on one side of an
 *      `InMemoryMcpTransport.createLinkedPair()`.
 *   2. `withMCP({ servers: [{transport: clientSide, ...}] })` wires
 *      the client side into an AppHarness.
 *   3. `app.createSession()` builds a session; its ToolExecutor
 *      auto-registers the discovered MCP tools (via
 *      `installer.registerExtensionTool` accumulating into
 *      `this.extensionTools` and the createSession path).
 *   4. `session.dispatch("<serverId>__<toolName>", input)` resolves
 *      the handler via the shared HandlerResolver, which proxies to
 *      `harness.callTool()` and maps the result to ContentBlock[].
 *   5. The model never directly sees MCP — every MCP tool looks like
 *      a regular local tool. Renderers / loop dispatcher work the
 *      same way as for any other tool registration.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "@agentick/app-next/react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { InMemoryMcpTransport, NoneAuth, withMCP } from "../index.js";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "mcp-e2e-exec",
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mkMcpServer(): Promise<{
  readonly server: Server;
  readonly clientTransport: InMemoryMcpTransport;
}> {
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  const server = new Server(
    { name: "fake-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "echoes the input",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
      {
        name: "add",
        description: "adds two numbers",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments as Record<string, unknown> | undefined;
    if (req.params.name === "echo") {
      return {
        content: [{ type: "text", text: `echo: ${(args?.message as string | undefined) ?? ""}` }],
      };
    }
    if (req.params.name === "add") {
      const a = (args?.a as number | undefined) ?? 0;
      const b = (args?.b as number | undefined) ?? 0;
      return {
        content: [{ type: "text", text: String(a + b) }],
      };
    }
    return {
      content: [{ type: "text", text: `unknown tool ${req.params.name}` }],
      isError: true,
    };
  });

  await server.connect(serverTransport);
  return { server, clientTransport };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("withMCP — end-to-end", () => {
  it("dispatches an MCP tool through the session and gets the server's response", async () => {
    const { server, clientTransport } = await mkMcpServer();

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [
            {
              serverId: "echo-server",
              transport: clientTransport,
              auth: new NoneAuth(),
            },
          ],
        }),
      ],
    });

    const session = await app.createSession();
    const content = await session.dispatch("echo-server__echo", { message: "hi" });

    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "text", text: "echo: hi" });

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("registers ALL discovered tools, not just the one called", async () => {
    const { server, clientTransport } = await mkMcpServer();

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [{ serverId: "math", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });

    const session = await app.createSession();

    // Both tools resolve through dispatch — implicit proof both
    // landed in the session's ToolExecutor. (SessionHarnessProtocol
    // doesn't surface the toolExecutor directly; dispatch is the
    // documented host-door for invoking by name.)
    const echoResult = await session.dispatch("math__echo", { message: "hi" });
    expect((echoResult[0] as { text: string }).text).toBe("echo: hi");

    const addResult = await session.dispatch("math__add", { a: 2, b: 3 });
    expect((addResult[0] as { text: string }).text).toBe("5");

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("honors a custom toolPrefix", async () => {
    const { server, clientTransport } = await mkMcpServer();

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [
            {
              serverId: "tools",
              transport: clientTransport,
              auth: new NoneAuth(),
              toolPrefix: "",
            },
          ],
        }),
      ],
    });

    const session = await app.createSession();
    // toolPrefix:"" means the tool is registered under its raw MCP
    // name. Dispatch by that name and confirm it resolves.
    const content = await session.dispatch("echo", { message: "raw" });
    expect((content[0] as { text: string }).text).toBe("echo: raw");

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("dispatched tool result content is shaped as ContentBlock[] (text passthrough)", async () => {
    const { server, clientTransport } = await mkMcpServer();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [{ serverId: "shape", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });
    const session = await app.createSession();
    const content = await session.dispatch("shape__echo", { message: "x" });
    // Every block carries an agentick-canonical `type` discriminator
    // (text in this case). Proves the content-mapper is in the path.
    expect(content[0]).toMatchObject({ type: "text" });
    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("closes the MCP harness when the app closes (onClose cascade)", async () => {
    const { server, clientTransport } = await mkMcpServer();

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [{ serverId: "closeme", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });

    await app.closeApp();
    // After closeApp, the MCP harness's onClose has run; subsequent
    // dispatches would fail. We don't assert a specific failure mode
    // here — just that closeApp resolves without hanging on the
    // harness teardown.
    await server.close();
  });
});
