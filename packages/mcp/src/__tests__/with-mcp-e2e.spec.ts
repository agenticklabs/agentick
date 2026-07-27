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
 *   4. `session.tools.dispatch("<serverId>__<toolName>", input)` resolves
 *      the handler via the shared HandlerResolver, which proxies to
 *      `harness.callTool()` and maps the result to ContentBlock[].
 *   5. The model never directly sees MCP — every MCP tool looks like
 *      a regular local tool. Renderers / loop dispatcher work the
 *      same way as for any other tool registration.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "@agentick/app/react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ToolExecutorProtocol } from "@agentick/spec";

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
        name: "render_widget",
        description: "returns a result carrying an MCP-Apps ui descriptor",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "fail_soft",
        description: "returns a domain error",
        inputSchema: { type: "object", properties: {} },
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
    if (req.params.name === "fail_soft") {
      return {
        content: [{ type: "text", text: "the ledger is closed" }],
        isError: true,
      };
    }
    if (req.params.name === "render_widget") {
      // An MCP-Apps style result: the frame descriptor rides result `_meta`.
      return {
        content: [{ type: "text", text: "widget ready" }],
        structuredContent: { rows: 2 },
        _meta: { ui: { resourceUri: "ui://widget/invoice-list", prefersBorder: true } },
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
    const content = await session.tools.dispatch("echo-server__echo", { message: "hi" });

    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "text", text: "echo: hi" });

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("preserves a consumed tool's result _meta / structuredContent / isError onto the DispatchResult", async () => {
    const { server, clientTransport } = await mkMcpServer();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [{ serverId: "apps", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });
    const session = (await app.createSession()) as unknown as {
      readonly id: string;
      readonly toolExecutor: ToolExecutorProtocol;
      close(): Promise<void>;
    };

    // Dispatch through the executor door (not `tools.dispatch`, which
    // projects content only) so the whole DispatchResult is observable.
    const result = await session.toolExecutor.dispatch({
      toolCallId: "call-ui-1",
      name: "apps__render_widget",
      input: {},
      context: { via: "dispatch", sessionId: session.id },
    });

    // `_meta` lands under the ONE namespaced result key — `metadata.mcp.meta`
    // — the same carriage the server-side projection reads. No new channel.
    expect(result.metadata).toEqual({
      mcp: { meta: { ui: { resourceUri: "ui://widget/invoice-list", prefersBorder: true } } },
    });
    // The two sidecars the bare content mapping also dropped.
    expect(result.structuredContent).toEqual({ rows: 2 });
    expect(result.isError).toBeUndefined();

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("surfaces a consumed tool's domain error as isError rather than a silent success", async () => {
    const { server, clientTransport } = await mkMcpServer();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [{ serverId: "err", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });
    const session = (await app.createSession()) as unknown as {
      readonly id: string;
      readonly toolExecutor: ToolExecutorProtocol;
      close(): Promise<void>;
    };

    const result = await session.toolExecutor.dispatch({
      toolCallId: "call-err-1",
      name: "err__fail_soft",
      input: {},
      context: { via: "dispatch", sessionId: session.id },
    });
    // A DOMAIN error, not a protocol failure: the dispatch resolves and the
    // model gets to reason about it — but it must not read as a success.
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "the ledger is closed" });

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
    const echoResult = await session.tools.dispatch("math__echo", { message: "hi" });
    expect((echoResult[0] as { text: string }).text).toBe("echo: hi");

    const addResult = await session.tools.dispatch("math__add", { a: 2, b: 3 });
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
    const content = await session.tools.dispatch("echo", { message: "raw" });
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
    const content = await session.tools.dispatch("shape__echo", { message: "x" });
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
