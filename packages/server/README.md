# @agentick/server

Server-side utilities for Agentick applications:

- **SSE utilities** - Stream events to clients via Server-Sent Events
- **Type re-exports** - Convenient imports from `@agentick/shared`

## Installation

```bash
npm install @agentick/server @agentick/core @agentick/shared
```

## Quick Start

For most use cases, use `@agentick/express` instead - it provides a complete handler:

```typescript
import { createApp } from "@agentick/core";
import { createAgentickHandler } from "@agentick/express";

const app = createApp(MyAgent, { model });
expressApp.use("/api/agent", createAgentickHandler(app));
```

## Direct Usage

If building a custom framework adapter:

```typescript
import { setSSEHeaders, createSSEWriter } from "@agentick/server";

// SSE endpoint
app.get("/events", (req, res) => {
  setSSEHeaders(res);
  const writer = createSSEWriter(res);

  // Write events
  writer.writeEvent({ type: "connected" });

  // Keepalive
  const keepalive = setInterval(() => {
    writer.writeComment("keepalive");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepalive);
    writer.close();
  });
});

// Streaming response
app.post("/send", async (req, res) => {
  setSSEHeaders(res);
  const writer = createSSEWriter(res);

  const session = app.getOrCreateSession(req.body.sessionId);
  const handle = session.send(req.body);

  for await (const event of handle) {
    writer.writeEvent(event);
  }

  writer.close();
});
```

## API Reference

### setSSEHeaders(res)

Set SSE headers on a response object:

```typescript
setSSEHeaders(res);
// Sets: Content-Type, Cache-Control, Connection, X-Accel-Buffering
```

### createSSEWriter(stream)

Create an SSE writer for streaming events:

```typescript
const writer = createSSEWriter(res);

writer.writeEvent({ type: "content_delta", delta: "Hello" });
writer.writeComment("keepalive");
writer.writeError({ code: "SESSION_NOT_FOUND", message: "Not found" });
writer.close();
```

## Type Re-exports

For convenience, this package re-exports common types from `@agentick/shared`:

```typescript
import type {
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SessionState,
  CreateSessionResponse,
} from "@agentick/server";
```

## Philosophy

This package follows the "primitives, not opinions" philosophy:

- **Minimal** - Just SSE utilities and type re-exports
- **Framework-agnostic** - Works with any HTTP framework
- **Composable** - Use what you need

For a complete server integration, use `@agentick/express`, `@agentick/nestjs`, or build your own using these utilities.
