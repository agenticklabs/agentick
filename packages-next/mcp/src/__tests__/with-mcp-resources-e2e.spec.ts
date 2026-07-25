/**
 * `withMCP` resource surfacing — end-to-end (ADR 62 Part B).
 *
 * A real MCP `Server` exposes resources + a template; `withMCP` surfaces
 * them into the session `ResourcesHarness` under the adopter alias
 * (`mcp://<serverId>/<originalUri>`). Covers the full claim set:
 *   - a remote resource is readable through `session.resources` under
 *     its alias; the proxy read round-trips to `resources/read`.
 *   - `withResources`' `resource_read` tool reads the same surfaced uri.
 *   - `notifications/resources/list_changed` re-surfaces the new catalog.
 *   - session close unregisters the surfaced bindings.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "@agentick/app-next/react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { waitFor } from "@agentick/utils-next/testing";
import { withResources } from "@agentick/resources-next";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Resource } from "@modelcontextprotocol/sdk/types.js";

import { InMemoryMcpTransport, NoneAuth, withMCP } from "../index.js";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hi");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "mcp-res-exec",
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

async function mkResourceServer(): Promise<{
  readonly server: Server;
  readonly clientTransport: InMemoryMcpTransport;
  readonly setResources: (r: readonly Resource[]) => void;
  readonly notifyChange: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  let current: readonly Resource[] = [
    { uri: "config://app", name: "App config", mimeType: "application/json" },
  ];

  const server = new Server(
    { name: "resource-server", version: "2.1.0" },
    { capabilities: { resources: { listChanged: true } } },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [...current] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: "file://{path}", name: "Files" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, text: `remote:${req.params.uri}` }],
  }));

  await server.connect(serverTransport);
  return {
    server,
    clientTransport,
    setResources: (r) => {
      current = r;
    },
    notifyChange: () => server.sendResourceListChanged(),
  };
}

describe("withMCP — resource surfacing e2e", () => {
  it("surfaces a remote resource under the alias; session.resources.read round-trips", async () => {
    const { server, clientTransport } = await mkResourceServer();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [{ serverId: "docs", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });
    const session = await app.createSession();

    const aliased = "mcp://docs/config://app";
    await waitFor(async () => session.resources.has(aliased), { timeoutMs: 1000, pollMs: 20 });
    const contents = await session.resources.read(aliased);
    expect(contents[0]).toMatchObject({ text: "remote:config://app" });

    // Template surfaced too — reads the stripped concrete uri remotely.
    const tContents = await session.resources.read("mcp://docs/file://readme.md");
    expect(tContents[0]).toMatchObject({ text: "remote:file://readme.md" });

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("the resource_read tool (withResources) reads a surfaced remote uri", async () => {
    const { server, clientTransport } = await mkResourceServer();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withResources(),
        withMCP({
          servers: [{ serverId: "docs", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });
    const session = await app.createSession();

    const aliased = "mcp://docs/config://app";
    await waitFor(async () => session.resources.has(aliased), { timeoutMs: 1000, pollMs: 20 });

    const blocks = await session.tools.dispatch("resource_read", { uri: aliased });
    expect(blocks[0]).toMatchObject({
      type: "resource",
      resource: { uri: "config://app", text: "remote:config://app" },
    });

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("re-surfaces on notifications/resources/list_changed", async () => {
    const { server, clientTransport, setResources, notifyChange } = await mkResourceServer();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [{ serverId: "docs", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });
    const session = await app.createSession();

    await waitFor(async () => session.resources.has("mcp://docs/config://app"), {
      timeoutMs: 1000,
      pollMs: 20,
    });

    // Server publishes a new catalog + pushes list_changed.
    setResources([{ uri: "db://schema", name: "Schema" }]);
    await notifyChange();

    await waitFor(async () => session.resources.has("mcp://docs/db://schema"), {
      timeoutMs: 1000,
      pollMs: 20,
    });
    // The old surfaced binding was torn down on re-surface.
    expect(session.resources.has("mcp://docs/config://app")).toBe(false);

    await session.close();
    await app.closeApp();
    await server.close();
  });

  it("session close unregisters the surfaced bindings", async () => {
    const { server, clientTransport } = await mkResourceServer();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [{ serverId: "docs", transport: clientTransport, auth: new NoneAuth() }],
        }),
      ],
    });
    const session = await app.createSession();
    const resources = session.resources;

    const aliased = "mcp://docs/config://app";
    await waitFor(async () => resources.has(aliased), { timeoutMs: 1000, pollMs: 20 });
    expect(resources.has(aliased)).toBe(true);

    await session.close();
    // withMCP's onClose cascade unregistered the surfaced binding.
    expect(resources.has(aliased)).toBe(false);

    await app.closeApp();
    await server.close();
  });
});
