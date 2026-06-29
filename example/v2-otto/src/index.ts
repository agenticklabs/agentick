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
import { withTasks } from "@agentick/tasks-next";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { Agent } from "./agent.js";

/**
 * Spin up an in-memory MCP server exposing two tools:
 *
 *   - `echo` — synchronous, inline-result. Demonstrates a vanilla
 *     `tools/call` round-trip over the MCP wire.
 *   - `lint_repo` — declared with `execution.taskSupport: "required"`.
 *     `tools/call` immediately returns a `CreateTaskResult` (the wire
 *     analogue of our local `session_task_ref`); the server runs the
 *     work in the background, emits `notifications/tasks/status`
 *     updates as it progresses, and responds to `tasks/get` /
 *     `tasks/result` / `tasks/cancel` requests from the client.
 *
 * The `InMemoryMcpTransport.createLinkedPair()` gives us a client /
 * server transport pair that talks over a shared in-process queue —
 * no subprocess, no socket, no network. Useful for tests AND for
 * demos like this one.
 *
 * On the client side, `withMCP` recognises `execution.taskSupport ===
 * "required"` (per #174 capability negotiation) and wraps the
 * discovered tool's handler in `ctx.tasks.submit(...)`. From the
 * model's perspective, calling `demo__lint_repo` is indistinguishable
 * from calling the local `deploy_branch` — both immediately yield a
 * `session_task_ref` content block and both are driven by the
 * `session_tasks_*` model-facing tools. Pattern B is transport-
 * transparent.
 */
function mkMcpServer(): {
  readonly clientTransport: InMemoryMcpTransport;
  readonly server: Server;
} {
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  const server = new Server(
    { name: "otto-demo-mcp", version: "1.0.0" },
    { capabilities: { tools: {}, tasks: { listChanged: false } } },
  );

  // ── Server-side task registry. Real adopters back this with whatever
  //    durable store fits — a queue, a database, an external job
  //    runner. For the demo we keep it in memory and run the work
  //    inside a fire-and-forget async function with an AbortController
  //    for cancellation.
  interface TaskRecord {
    status: "working" | "completed" | "failed" | "cancelled";
    statusMessage?: string;
    result?: CallToolResult;
    failureReason?: string;
    readonly abort: AbortController;
  }
  const tasks = new Map<string, TaskRecord>();
  let taskSeq = 0;
  const nextTaskId = (): string => `task-${Date.now().toString(36)}-${++taskSeq}`;

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
      {
        name: "lint_repo",
        description:
          "Lint the whole repository — runs ~2 seconds in the background. " +
          "Returns a task reference immediately; poll / await / cancel via the " +
          "`session_tasks_*` tools.",
        inputSchema: {
          type: "object",
          properties: {
            strict: {
              type: "boolean",
              description: "If true, treat warnings as errors.",
            },
          },
        },
        execution: { taskSupport: "required" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "echo") {
      const message = String(
        (req.params.arguments as { message?: string } | undefined)?.message ?? "",
      );
      return { content: [{ type: "text", text: `echo: ${message}` }] };
    }

    if (req.params.name === "lint_repo") {
      const strict =
        Boolean((req.params.arguments as { strict?: boolean } | undefined)?.strict) === true;
      const taskId = nextTaskId();
      const record: TaskRecord = { status: "working", abort: new AbortController() };
      tasks.set(taskId, record);

      // Run the work in the background. The async closure is
      // intentionally not awaited from this handler — `tools/call`
      // must return promptly with the `CreateTaskResult`.
      void (async () => {
        const stages: ReadonlyArray<readonly [string, number]> = [
          ["scanning-files", 500],
          ["applying-rules", 700],
          ["formatting-report", 400],
        ];
        try {
          for (const [stage, ms] of stages) {
            if (record.abort.signal.aborted) {
              record.status = "cancelled";
              record.failureReason = "client cancelled";
              await server.notification({
                method: "notifications/tasks/status",
                params: { taskId, status: "cancelled" },
              });
              return;
            }
            record.statusMessage = stage;
            await server.notification({
              method: "notifications/tasks/status",
              params: { taskId, status: "working", statusMessage: stage },
            });
            await new Promise<void>((r) => setTimeout(r, ms));
          }
          const summary = strict ? "0 errors, 0 warnings (strict)" : "0 errors, 3 warnings";
          record.status = "completed";
          record.result = { content: [{ type: "text", text: `lint complete — ${summary}` }] };
          await server.notification({
            method: "notifications/tasks/status",
            params: { taskId, status: "completed" },
          });
        } catch (err) {
          record.status = "failed";
          record.failureReason = err instanceof Error ? err.message : String(err);
          await server.notification({
            method: "notifications/tasks/status",
            params: { taskId, status: "failed" },
          });
        }
      })();

      return { task: { taskId, status: "working", ttl: 60_000 } };
    }

    throw new Error(`unknown tool: ${req.params.name}`);
  });

  server.setRequestHandler(GetTaskRequestSchema, async (req) => {
    const t = tasks.get(req.params.taskId);
    if (!t) throw new Error(`unknown task: ${req.params.taskId}`);
    return {
      taskId: req.params.taskId,
      status: t.status,
      ...(t.statusMessage !== undefined ? { statusMessage: t.statusMessage } : {}),
    };
  });

  server.setRequestHandler(GetTaskPayloadRequestSchema, async (req) => {
    const t = tasks.get(req.params.taskId);
    if (!t) throw new Error(`unknown task: ${req.params.taskId}`);
    if (t.status === "completed" && t.result) return t.result;
    if (t.status === "failed") {
      return {
        content: [{ type: "text", text: `lint failed: ${t.failureReason ?? "unknown"}` }],
        isError: true,
      };
    }
    throw new Error(`task ${req.params.taskId} not yet terminal (status=${t.status})`);
  });

  server.setRequestHandler(CancelTaskRequestSchema, async (req) => {
    const t = tasks.get(req.params.taskId);
    if (t && t.status === "working") {
      t.abort.abort();
    }
    return {};
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
    console.error("OPENAI_API_KEY is not set. Copy .env.example to .env and fill in your key.");
    process.exit(1);
  }

  // ─── Set up an in-memory MCP server. Real adopters point
  //     `withMCP` at a stdio transport (subprocess MCP server) or
  //     a streamable-HTTP transport (remote MCP server). The
  //     in-memory server exposes both an `echo` (inline) and a
  //     `lint_repo` (Pattern B via the MCP task wire) tool.
  const { clientTransport } = mkMcpServer();

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
      // `withTasks()` — substrate + per-session TasksHarness + auto-
      // registered `session_tasks_list / get / cancel / await` tools.
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
    // Run two prompts back-to-back on the same session so the Pattern B
    // task ref persists across ticks — the model kicks off the deploy
    // in the first turn, then is asked to check on / await it in the
    // second turn.
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
  }
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
