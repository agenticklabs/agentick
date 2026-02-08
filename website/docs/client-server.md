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

## React Integration

```tsx
import { useSession, useMessages } from "@agentick/react";

function Chat() {
  const session = useSession("my-session");
  const messages = useMessages(session);
  const [input, setInput] = useState("");

  return (
    <div>
      {messages.map((msg, i) => (
        <div key={i} className={msg.role}>
          {msg.content}
        </div>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            session.send(input);
            setInput("");
          }
        }}
      />
    </div>
  );
}
```

## Transport

The client-server communication uses:

- **SSE (Server-Sent Events)** for streaming model responses
- **HTTP POST** for method calls and message sending
- **WebSocket** (optional) for bidirectional real-time communication

The transport is abstracted — the client API is the same regardless of the underlying transport.
