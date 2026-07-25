/**
 * Agentick v2 end-to-end example — real model edition.
 *
 * Demonstrates the canonical user surface plus the v2 layered-tools
 * cascade end-to-end through a real OpenAI model:
 *
 *   - Compiler-emitted tools — `<Calculator.Tool />` inside the
 *     `<Agent />` JSX. The compiler binding wins everything on
 *     name collision.
 *   - App-level tool — `time_now`. Bound at app construction; every
 *     session this app spawns sees it.
 *   - MCP-discovered tools — an in-memory MCP **server harness** (v2's
 *     `McpServerHarness`) exposing `echo` (inline) and `lint_repo`
 *     (Pattern B over the MCP wire). Auto-registered by `withMCP`;
 *     the model sees them with NO JSX ceremony.
 *
 * The MCP server is the v2 `McpServerHarness` — same `createTool`
 * authoring surface as in-process tools, no hand-rolled task
 * bookkeeping (`tasks/get` / `tasks/result` / `tasks/cancel` /
 * `notifications/tasks/status` are all served by the harness's
 * projection layer per #171d.3).
 *
 * Run:
 *   1. cp .env.example .env  (then fill in OPENAI_API_KEY)
 *   2. pnpm --filter example-v2-otto dev
 */

import "dotenv/config";
import React from "react";
import { z } from "zod";

import { createApp } from "@agentick/app-next/react";
import { aisdk } from "@agentick/model-ai-sdk-next";
import { openai } from "@ai-sdk/openai";
import type { AppExtension, ContentBlock } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { NoneAuth, withMCP } from "@agentick/mcp-next";
import { inMemoryServerTransport, McpServerHarness } from "@agentick/mcp-next/server";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { withTasks } from "@agentick/tasks-next";
import { createTool } from "@agentick/tool-next";

import { Agent } from "./agent.js";

/**
 * Spin up an in-memory MCP server harness exposing two tools:
 *
 *   - `echo` — inline result.
 *   - `lint_repo` — annotated `taskSupport: "required"`. The handler
 *     returns `ctx.tasks!.submit(...)` exactly the way an in-process
 *     Pattern B tool would (cf. `deploy_branch` in `agent.tsx`). The
 *     server harness recognises the TaskHandle return, projects it
 *     to `CreateTaskResult` on the wire, and serves the full
 *     `tasks/*` lifecycle automatically — adopters write zero
 *     bookkeeping for the MCP task wire.
 *
 * Compare to the v1-style raw-SDK approach (replaced #171d.3): the
 * server-side task bookkeeping (Map of taskId → status, manual
 * `tools/call` → `CreateTaskResult`, hand-rolled `tasks/get` etc.)
 * collapses into the standard `createTool` + `ctx.tasks!.submit`
 * pattern that already works in-process.
 */
async function mkMcpServer(): Promise<{
  readonly clientTransport: Awaited<
    ReturnType<ReturnType<typeof inMemoryServerTransport>["connect"]>
  >;
  readonly harness: McpServerHarness;
}> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    "srv:otto-demo",
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "otto-demo-mcp",
      transports: [transport],
      serverInfo: { name: "otto-demo-mcp", version: "1.0.0" },
      tools: [
        createTool({
          name: "echo",
          description: "Echo the supplied message back as text.",
          inputSchema: z.object({ message: z.string() }),
          handler: async ({ message }) => [
            { type: "text", text: `echo: ${message}` } as ContentBlock,
          ],
        }),
        createTool({
          name: "lint_repo",
          description:
            "Lint the whole repository — runs ~2 seconds in the background. " +
            "Returns a task reference immediately; poll / await / cancel via the " +
            "`task_*` tools.",
          inputSchema: z.object({
            strict: z.boolean().optional().describe("If true, treat warnings as errors."),
          }),
          annotations: { taskSupport: "required" },
          handler: async ({ strict }, { ctx }) => {
            return ctx.tasks!.submit(async ({ signal, setStatusMessage }) => {
              const stages = [
                ["scanning-files", 500],
                ["applying-rules", 700],
                ["formatting-report", 400],
              ] as const;
              for (const [stage, ms] of stages) {
                if (signal.aborted) throw new DOMException("aborted", "AbortError");
                setStatusMessage(stage);
                await new Promise<void>((r) => setTimeout(r, ms));
              }
              const summary = strict ? "0 errors, 0 warnings (strict)" : "0 errors, 3 warnings";
              return [{ type: "text", text: `lint complete — ${summary}` } as ContentBlock];
            });
          },
        }),
      ],
    },
  );
  await harness.ready;
  await harness.start();
  const clientTransport = await transport.connect();
  return { clientTransport, harness };
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
    console.error("OPENAI_API_KEY is not set. Copy .env.example to .env and fill in your key.");
    process.exit(1);
  }

  // ─── Set up an in-memory MCP server. Real adopters point
  //     `withMCP` at a stdio transport (subprocess MCP server) or
  //     a streamable-HTTP transport (remote MCP server). The
  //     in-memory server exposes both an `echo` (inline) and a
  //     `lint_repo` (Pattern B via the MCP task wire) tool.
  const { clientTransport, harness: mcpServer } = await mkMcpServer();

  // ─── Construct the app with all the layered seams wired:
  const app = await createApp(React.createElement(Agent), {
    model: aisdk(openai("gpt-4o-mini")),

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
      // `withTasks()` — substrate + per-session TasksHarness + auto-
      // registered `task_list / get / cancel / await` tools.
      // Enables the `taskSupport: "required"` annotation on
      // `deploy_branch` (Pattern B — task ref returned to the model)
      // and the transparent task awaiting on `slow_compute` (Pattern A).
      withTasks(),
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
    // Run three prompts back-to-back on the same session so the Pattern B
    // task refs persist across ticks — the model kicks off a local deploy
    // in turn 1, drives it across turn 2, then exercises the MCP-remote
    // Pattern B path via demo__lint_repo in turn 3.
    const session = await app.createSession();
    try {
      const turn = async (text: string, label: string): Promise<void> => {
        console.log(`→ User: ${text}\n`);
        const handle = await session.send({
          messages: [{ role: "user", content: [{ type: "text", text }] }],
        });
        const result = await handle.result;
        console.log("← Assistant:", result.response);
        console.log(
          `[${label} — ${result.ticks} tick(s), ${result.usage.totalTokens} tokens, stop=${result.stopReason}]\n`,
        );
      };

      await turn(
        "Please deploy the 'feat/v2' branch to staging. Don't wait — just kick it off and tell me the task id.",
        "tick 1 — local Pattern B (deploy_branch)",
      );
      await turn(
        "Is it done yet? If not, await it for me.",
        "tick 2 — drive the local task across ticks",
      );
      await turn(
        "Now lint the repo using the demo MCP server's lint_repo tool (strict=false). " +
          "Wait for it to finish and tell me the result.",
        "tick 3 — Pattern B across the MCP wire (demo__lint_repo)",
      );
    } finally {
      await session.close();
    }
  } finally {
    await app.closeApp();
    await mcpServer.close();
  }
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
