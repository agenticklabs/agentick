# @tentickle/server

Server-side utilities for Tentickle applications:

- **SSE utilities** - Stream events to clients via Server-Sent Events
- **Type re-exports** - Convenient imports from `@tentickle/shared`

## Installation

```bash
npm install @tentickle/server @tentickle/core @tentickle/shared
```

## Quick Start

For most use cases, use `@tentickle/express` instead - it provides a complete handler:

```typescript
import { createApp } from "@tentickle/core";
import { createTentickleHandler } from "@tentickle/express";

const app = createApp(MyAgent, { model });
expressApp.use("/api/agent", createTentickleHandler(app));
```

## Direct Usage

If building a custom framework adapter:

```typescript
import { setSSEHeaders, createSSEWriter } from "@tentickle/server";

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

For convenience, this package re-exports common types from `@tentickle/shared`:

```typescript
import type {
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SessionState,
  CreateSessionResponse,
} from "@tentickle/server";
```

## Philosophy

This package follows the "primitives, not opinions" philosophy:

- **Minimal** - Just SSE utilities and type re-exports
- **Framework-agnostic** - Works with any HTTP framework
- **Composable** - Use what you need

For a complete server integration, use `@tentickle/express`, `@tentickle/nestjs`, or build your own using these utilities.
