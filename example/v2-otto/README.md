# example-v2-otto

End-to-end Agentick v2 example with a **real model** (OpenAI via the AI SDK adapter), demonstrating the full layered-tools cascade end-to-end.

## What this demonstrates

- **Ergonomic API surface** — `createApp` + `aisdk` + `<Agent />` + `app.send`.
- **The full layered-tools cascade** — three of the seven layered seams exercised in one example:
  - Reconciler-emitted tools (JSX `<Calculator.Tool />`)
  - App-level tools (`createApp({ tools: [...] })`)
  - MCP-discovered tools (in-memory MCP server, `withMCP` extension)
- **MCP tools without `<MCPTools>`** — discovered tools auto-appear via the layered-tools compile. No JSX ceremony.
- **`useKnob` reactive state** — the model can flip `verbose` via `set_knob`; the next render's system prompt changes.
- **Pattern A vs Pattern B background tasks** — `withTasks()` is installed; three task-using tools demonstrate both patterns LOCALLY AND across the MCP wire:
  - **Pattern A (`slow_compute`)** — submits a `ctx.tasks.submit(...)` task; the executor awaits the handle transparently. The model sees only the final result; never the taskId.
  - **Pattern B local (`deploy_branch`, `taskSupport: "required"`)** — submits a task; the executor returns immediately with a `session_task_ref` JSON content block. The model uses the auto-registered `session_tasks_get / session_tasks_cancel / session_tasks_await` tools to manage the task across subsequent ticks.
  - **Pattern B over MCP (`demo__lint_repo`, MCP `execution.taskSupport: "required"`)** — discovered from the in-memory MCP server (via `withMCP`). The server is a v2 `McpServerHarness` (post-#171d.3) where the tool is just `createTool({ annotations: { taskSupport: "required" }, handler: ({ ctx }) => ctx.tasks!.submit(...) })` — the SAME authoring shape as in-process Pattern B tools. The harness recognises the `TaskHandle` return, projects it to `CreateTaskResult` on the wire, and serves `tasks/get` / `tasks/result` / `tasks/cancel` / `tasks/list` plus `notifications/tasks/status` automatically. The `withMCP` client recognises `execution.taskSupport === "required"`, wraps the handler in `ctx.tasks.submit(...)`, and from the model's perspective the tool is indistinguishable from `deploy_branch` — same `session_task_ref` block, same `session_tasks_*` driver tools. **Pattern B is transport-transparent — same handler code, both sides.**

## Run

```bash
cp .env.example .env
# Fill in OPENAI_API_KEY in .env

pnpm --filter example-v2-otto dev
```

## What you'll see

The example runs three turns on a shared session to demonstrate Pattern B across ticks AND across the MCP wire:

1. **Turn 1** — asks the model to kick off a `deploy_branch('feat/v2', 'staging')` deployment without waiting. The model calls `deploy_branch`; because the tool is annotated `taskSupport: "required"`, the executor returns a `session_task_ref` content block immediately (the local task continues running in the background). The model reports back the task id.
2. **Turn 2** — asks "is it done yet? if not, await it." The model calls `session_tasks_get` to check status, then `session_tasks_await` to block until the deploy task transitions to `completed` — and reports the final result.
3. **Turn 3** — asks the model to lint the repo via the MCP-discovered `demo__lint_repo` tool and wait for the result. The MCP server returns a `CreateTaskResult` over the wire on `tools/call`, emits `notifications/tasks/status` updates while it works, and finally serves the result via `tasks/result`. The `withMCP` client mirrors the remote task into the local `TasksHarness`; the model drives it with the same `session_tasks_*` tools it used in turn 2 — there's no client-side difference between a local Pattern B task and an MCP-remote Pattern B task.

Exact wording + token counts vary by run.

## The agent

```tsx
// src/agent.tsx
import { z } from "zod";
import { System, createTool } from "@agentick/reconciler-react-next";
import { Knobs, useKnob } from "@agentick/knobs-next/react";

const Calculator = createTool({
  name: "calculator",
  description: "Evaluate a JS arithmetic expression",
  inputSchema: z.object({ expression: z.string() }),
  handler: async ({ expression }) => {
    const result = new Function(`"use strict"; return (${expression})`)();
    return [{ type: "text" as const, text: `${expression} = ${result}` }];
  },
});

export function Agent() {
  const [verbose] = useKnob<boolean>("verbose", false, {
    description: "Detailed step-by-step explanations.",
    valueType: "boolean",
  });
  return (
    <>
      <System>
        You are a concise assistant with a calculator tool.
        {verbose ? " Explain step by step." : " Be terse."}
      </System>
      <Calculator.Tool />
      <Knobs />
    </>
  );
}
```

## The runner — layered tools wired

```ts
// src/index.ts (abridged)
import { createApp } from "@agentick/app-next/react";
import { aisdk } from "@agentick/model-ai-sdk-next";
import { openai } from "@ai-sdk/openai";
import { jsonSchema } from "@agentick/spec-next";
import { InMemoryMcpTransport, NoneAuth, withMCP } from "@agentick/mcp-next";

const { clientTransport } = mkMcpEchoServer();

const app = await createApp(React.createElement(Agent), {
  executor: aisdk(openai("gpt-4o-mini")),

  // App-level tools — every session sees these.
  tools: [
    {
      id: "time_now",
      name: "time_now",
      description: "Returns the current UTC timestamp.",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      handlerRef: "h.time_now",
    },
  ],

  // MCP — discovered tools auto-register at the extension slot.
  extensions: [
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

const result = await app.send("What's 47 * 23?");
console.log(result.response);
await app.closeApp();
```

## The layered-tools ladder

The v2 framework resolves tools through a precedence ladder that's identical at every layer. Most-specific wins on name collision:

```
session > execution > {app, extension@app} > gateway > runtime
                                  ^
                              MCP lives here
```

Each layer accepts the same `tools: ToolDeclaration[]` shape. Layers exercised in this example:

| Layer         | Where                                        | Binding                                |
| ------------- | -------------------------------------------- | -------------------------------------- |
| Reconciler    | JSX `<Calculator.Tool />` inside `<Agent />` | `{ scope: "reconciler", mountId }`     |
| Extension@app | `withMCP` extension                          | `{ scope: "extension", level: "app" }` |
| App           | `createApp({ tools: [...] })`                | `{ scope: "app", appId }`              |

Layers not exercised here but available:

| Layer     | Where                                 | Binding                               |
| --------- | ------------------------------------- | ------------------------------------- |
| Gateway   | `createGateway({ tools: [...] })`     | `{ scope: "gateway" }`                |
| Session   | `app.createSession({ tools: [...] })` | `{ scope: "session", sessionId }`     |
| Execution | `session.send({ tools: [...] })`      | `{ scope: "execution", executionId }` |

If two layers declare a tool with the same `name`, the higher-precedence binding wins. The reconciler binding overrides everything — JSX is the override mechanism for any MCP/app/extension tool.

## Switching providers

```ts
import { anthropic } from "@ai-sdk/anthropic";
// ...
aisdk(anthropic("claude-3-5-sonnet-latest"));
```

Add `ANTHROPIC_API_KEY` to `.env`.

## Switching MCP transports

The demo uses `InMemoryMcpTransport` (zero ceremony, no external process). Real adopters point at:

- **`StdioClientTransport`** — subprocess MCP servers (filesystem MCP, etc.).
- **Streamable HTTP** — remote MCP servers (the MCP spec's HTTP transport, when shipped).

The `serverId` becomes the prefix for tool names — `demo__echo` here. Override with `toolPrefix` per server.

## Notes

- The `calculator` tool uses `new Function()` for demo simplicity — **do not do this in production**. Use a real expression parser or sandbox.
- App-level tools declared via `createApp({ tools })` need their handlers registered via the HandlerResolver (typically through a `<Tool>` component or `defineToolExecutor` factory). The example declares `time_now` to demonstrate the binding shape; the handler is dispatch-only here.
- `withMCP` does NOT need a companion `<MCPTools>` JSX component — discovered tools flow through the layered-tools registry compile and the model sees them at every tick.
