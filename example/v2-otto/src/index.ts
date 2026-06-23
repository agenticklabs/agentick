/**
 * Agentick v2 end-to-end example — real model edition.
 *
 * Demonstrates the canonical user surface plus the v2 layered-tools
 * cascade end-to-end through a real OpenAI model:
 *
 *   - Reconciler-emitted tools — `<Calculator.Tool />` inside the
 *     `<Agent />` JSX. The reconciler binding wins everything on
 *     name collision.
 *   - App-level tool — `time_now`. Bound at app construction; every
 *     session this app spawns sees it.
 *   - MCP-discovered tools — an in-memory MCP server exposing
 *     `echo`. Auto-registered by `withMCP`; the model sees them
 *     with NO JSX ceremony (no `<MCPTools>` needed).
 *
 * Run:
 *   1. cp .env.example .env  (then fill in OPENAI_API_KEY)
 *   2. pnpm --filter example-v2-otto dev
 */

import "dotenv/config";
import React from "react";

import { createApp } from "@agentick/app-next/react";
import { aisdk } from "@agentick/executor-ai-sdk-next";
import { openai } from "@ai-sdk/openai";
import type { AppExtension } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { InMemoryMcpTransport, NoneAuth, withMCP } from "@agentick/mcp-next";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { Agent } from "./agent.js";

/**
 * Spin up an in-memory MCP server exposing an `echo` tool. The
 * `InMemoryMcpTransport.createLinkedPair()` gives us a client/server
 * transport pair that talks over a shared in-process queue — no
 * subprocess, no socket, no network. Useful for tests AND for
 * demos like this one.
 */
function mkMcpEchoServer(): { readonly clientTransport: InMemoryMcpTransport; readonly server: Server } {
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  const server = new Server(
    { name: "otto-demo-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echoes the supplied `message` back as text.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const message = String((req.params.arguments as { message?: string } | undefined)?.message ?? "");
    return { content: [{ type: "text", text: `echo: ${message}` }] };
  });
  void server.connect(serverTransport);
  return { clientTransport, server };
}

/**
 * Tiny inline app-level extension that registers the `time_now`
 * handler with the shared HandlerResolver. App-level tool
 * declarations (passed via `createApp({ tools })`) are tagged at
 * `{ scope: "app", appId }`; their handlers go through the same
 * resolver every other tool uses. This is the canonical pattern
 * for app-level tools-with-handlers when JSX isn't the right home
 * (e.g., the handler needs no React deps).
 */
function timeExtension(): AppExtension {
  return {
    name: "otto.time",
    target: "app",
    install(installer) {
      installer.registerToolHandler("h.time_now", async () => [
        { type: "text", text: new Date().toISOString() },
      ]);
    },
  };
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "OPENAI_API_KEY is not set. Copy .env.example to .env and fill in your key.",
    );
    process.exit(1);
  }

  // ─── Set up an in-memory MCP server. Real adopters point
  //     `withMCP` at a stdio transport (subprocess MCP server) or
  //     a streamable-HTTP transport (remote MCP server).
  const { clientTransport } = mkMcpEchoServer();

  // ─── Construct the app with all the layered seams wired:
  const app = await createApp(React.createElement(Agent), {
    executor: aisdk({ model: openai("gpt-4o-mini") }),

    // App-level tools — every session sees them. Tagged with
    // `binding: { scope: "app", appId }` at construction. Declared
    // here; handlers wired by the `timeExtension` below (the
    // canonical app-level pattern: declaration + handler in one
    // extension factory).
    tools: [
      {
        id: "time_now",
        name: "time_now",
        description: "Returns the current UTC timestamp in ISO 8601 format.",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        handlerRef: "h.time_now",
      },
    ],

    // Extensions:
    //   - `timeExtension` — small inline extension registering the
    //     `time_now` handler. The canonical pattern for app-level
    //     tools-with-handlers when you don't want to author JSX.
    //   - `withMCP` — auto-discovers tools from the in-memory server
    //     and registers them with
    //     `binding: { scope: "extension", level: "app" }`. No
    //     `<MCPTools>` JSX needed — the layered-tools compile picks
    //     them up at every tick.
    extensions: [
      timeExtension(),
      withMCP({
        servers: [
          {
            serverId: "demo",
            transport: clientTransport,
            auth: new NoneAuth(),
          },
        ],
      }),
    ],
  });

  try {
    console.log("→ User: What's 47 * 23? Also use the demo__echo tool to say 'hi'.\n");
    const result = await app.send(
      "What's 47 * 23? Also use the demo__echo tool to say 'hi'.",
    );
    console.log("← Assistant:", result.response);
    console.log(
      `\n[${result.ticks} tick(s), ${result.usage.totalTokens} tokens, stop=${result.stopReason}]`,
    );
  } finally {
    await app.closeApp();
  }
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
