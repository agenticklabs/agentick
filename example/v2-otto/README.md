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

## Run

```bash
cp .env.example .env
# Fill in OPENAI_API_KEY in .env

pnpm --filter example-v2-otto dev
```

## What you'll see

The agent answers `"What's 47 * 23? Also use the demo__echo tool to say 'hi'."`. The model:

1. Calls the reconciler-declared `calculator` tool (JSX `<Calculator.Tool />`).
2. Calls the MCP-discovered `demo__echo` tool (in-memory MCP server, auto-discovered by `withMCP`).
3. Composes a final reply.

```
→ User: What's 47 * 23? Also use the demo__echo tool to say 'hi'.

← Assistant: 47 × 23 = 1081. (echo says: hi)

[3 tick(s), 247 tokens, stop=end]
```

(Exact wording + token counts vary by run.)

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
import { aisdk } from "@agentick/executor-ai-sdk-next";
import { openai } from "@ai-sdk/openai";
import { jsonSchema } from "@agentick/spec-next";
import { InMemoryMcpTransport, NoneAuth, withMCP } from "@agentick/mcp-next";

const { clientTransport } = mkMcpEchoServer();

const app = await createApp(React.createElement(Agent), {
  executor: aisdk({ model: openai("gpt-4o-mini") }),

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

| Layer | Where | Binding |
|---|---|---|
| Reconciler | JSX `<Calculator.Tool />` inside `<Agent />` | `{ scope: "reconciler", mountId }` |
| Extension@app | `withMCP` extension | `{ scope: "extension", level: "app" }` |
| App | `createApp({ tools: [...] })` | `{ scope: "app", appId }` |

Layers not exercised here but available:

| Layer | Where | Binding |
|---|---|---|
| Gateway | `createGateway({ tools: [...] })` | `{ scope: "gateway" }` |
| Session | `app.createSession({ tools: [...] })` | `{ scope: "session", sessionId }` |
| Execution | `session.send({ tools: [...] })` | `{ scope: "execution", executionId }` |

If two layers declare a tool with the same `name`, the higher-precedence binding wins. The reconciler binding overrides everything — JSX is the override mechanism for any MCP/app/extension tool.

## Switching providers

```ts
import { anthropic } from "@ai-sdk/anthropic";
// ...
aisdk({ model: anthropic("claude-3-5-sonnet-latest") })
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
