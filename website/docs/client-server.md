# Client-Server

Agentick provides a client SDK for connecting to a running gateway from browser or Node.js.

## Server Setup

```tsx
import express from "express";
import { createGateway } from "@agentick/gateway";
import { createExpressMiddleware } from "@agentick/express";

const gateway = createGateway({ app: myAgent });
const server = express();
server.use("/api", createExpressMiddleware({ gateway }));
server.listen(3000);
```

## Client Usage

```tsx
import { createClient } from "@agentick/client";

const client = createClient({
  url: "http://localhost:3000/api",
});

// Create or join a session
const session = client.session("my-session-id");

// Send a message and stream the response
for await (const chunk of session.send("Hello!")) {
  process.stdout.write(chunk.text ?? "");
}
```

### Dispatching Tools

The session accessor supports `dispatch` for invoking any registered tool by name without model involvement:

```tsx
const session = client.session("my-session-id");

// Invoke any tool — regular or audience: "user"
const result = await session.dispatch("add-dir", { path: "/tmp/data" });
```

This is used by TUI slash commands and client-side actions. It works on all tools — the most common pattern is dispatching `audience: "user"` tools (hidden from model), but regular tools are equally dispatchable.

## React Integration

`useChat` is the all-in-one hook — messages, input steering, and tool confirmations. It auto-subscribes to the SSE transport.

```tsx
import { AgentickProvider, useChat, useStreamingText } from "@agentick/react";

function Chat() {
  const { messages, chatMode, submit, respondToConfirmation, toolConfirmation, lastSubmitted } =
    useChat({ sessionId: "my-session" });
  const { text: streamingText, isStreaming } = useStreamingText();
  const [input, setInput] = useState("");

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id} className={msg.role}>
          {typeof msg.content === "string" ? msg.content : "..."}
        </div>
      ))}

      {isStreaming && <div className="assistant">{streamingText}</div>}

      {toolConfirmation && (
        <div>
          <p>Allow {toolConfirmation.request.name}?</p>
          <button onClick={() => respondToConfirmation({ approved: true })}>Allow</button>
          <button onClick={() => respondToConfirmation({ approved: false })}>Deny</button>
        </div>
      )}

      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && input.trim()) {
            submit(input);
            setInput("");
          }
        }}
      />
    </div>
  );
}

function App() {
  return (
    <AgentickProvider clientConfig={{ baseUrl: "/api" }}>
      <Chat />
    </AgentickProvider>
  );
}
```

For finer control, compose individual primitives: `useMessages`, `useToolConfirmations`, `useMessageSteering`. See the `@agentick/react` README for the full hook reference.

## Terminal UI

`@agentick/tui` is a terminal client built on the same `@agentick/client` and `@agentick/react` hooks. It connects to agents locally or over HTTP/SSE, with a **pluggable UI** — swap the interface by passing any Ink component:

```tsx
import { createTUI } from "@agentick/tui";

// Default chat UI
createTUI({ url: "http://localhost:3000/api" }).start();

// Custom dashboard UI
createTUI({ url: "http://localhost:3000/api", ui: MyDashboard }).start();
```

Or from the CLI:

```sh
agentick-tui --url http://localhost:3000/api --ui ./dashboard.tsx
```

See the [Terminal UI guide](/docs/tui) for details.

## Transport

The client-server communication supports multiple transports:

- **SSE/HTTP** — Server-Sent Events for streaming + HTTP POST for sending. Default for browser clients.
- **WebSocket** — Bidirectional real-time via `createWSTransport`. Browser and Node.js.
- **Unix Socket** — NDJSON over Unix domain socket via `createUnixSocketClientTransport`. Node.js only. Used for daemon mode where the gateway runs as a background process and TUI clients connect locally.
- **Local** — In-process bridge via `createLocalTransport`. No network overhead.

The transport is abstracted — the client API is the same regardless of the underlying transport. The TUI, React web apps, and custom Node.js clients all use the same `ClientTransport` interface.

WebSocket and Unix socket transports are built on `createRPCTransport` (from `@agentick/shared`), a shared factory that provides all protocol machinery. Each transport is a thin delegate (~120 lines) providing wire-specific I/O.
