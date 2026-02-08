# @agentick/server Architecture

Server-side utilities for Agentick applications.

## Wire Protocol

> **All wire protocol types come from `@agentick/shared`.**
>
> See [`@agentick/shared/ARCHITECTURE.md`](../shared/ARCHITECTURE.md) for the protocol specification.

```typescript
// Protocol types - ALWAYS from shared, never duplicated
import type { StreamEvent, SendInput, Message } from "@agentick/shared";
```

## Design Philosophy

**This package provides SSE utilities and type re-exports.**

The actual session management is handled by `@agentick/core` (`App`, `Session`).
Framework integration is handled by `@agentick/express` (or other adapters).

This package is kept minimal - just the utilities that multiple adapters might need.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    @agentick/express                        │
│                    @agentick/nestjs                         │
│                    @agentick/socket.io                      │
│                                                              │
│   createAgentickHandler(app) / modules                      │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│                     @agentick/server                         │
│                                                              │
│   ┌──────────────────┐       ┌──────────────────┐            │
│   │  SSE Utilities   │       │  Type Re-exports │            │
│   │                  │       │                  │            │
│   │  createSSEWriter │       │  from @shared    │            │
│   │  setSSEHeaders   │       │  SessionState    │            │
│   │  streamToSSE     │       │  StreamEvent     │            │
│   └──────────────────┘       └──────────────────┘            │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│                     @agentick/core                           │
│                                                              │
│   App, Session, SessionRegistry                              │
└──────────────────────────────────────────────────────────────┘
```

## Key Components

### SSE Utilities

Helpers for Server-Sent Events:

```typescript
import { createSSEWriter, setSSEHeaders } from "@agentick/server";

// Set SSE headers on response
setSSEHeaders(res);

// Create SSE writer
const writer = createSSEWriter(res);

// Write events
writer.writeEvent({ type: "content_delta", delta: "Hello" });
writer.writeComment("keepalive");
writer.writeError({ code: "SESSION_NOT_FOUND", message: "Not found" });

// Close when done
writer.close();
```

### SSE Writer Interface

```typescript
interface SSEWriter {
  writeEvent(event: unknown): void;
  writeComment(comment: string): void;
  writeError(error: { type?: string; code?: string; message: string }): void;
  close(): void;
}
```

### Type Re-exports

Re-exports from `@agentick/shared` for convenience:

```typescript
export type {
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SessionState,
  CreateSessionResponse,
} from "@agentick/shared";
```

## File Structure

```
packages/server/src/
├── index.ts    # Public exports
├── types.ts    # Type re-exports from shared
└── sse.ts      # SSE utilities
```

## Usage

### With Express

```typescript
import { setSSEHeaders, createSSEWriter } from "@agentick/server";

app.get("/events", (req, res) => {
  setSSEHeaders(res);
  const writer = createSSEWriter(res);

  // Write events
  writer.writeEvent({ type: "connected", connectionId: "123" });

  // Keepalive
  const keepalive = setInterval(() => {
    writer.writeComment("keepalive");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepalive);
    writer.close();
  });
});
```

### Streaming Events

```typescript
import { setSSEHeaders, createSSEWriter } from "@agentick/server";

app.post("/send", async (req, res) => {
  setSSEHeaders(res);
  const writer = createSSEWriter(res);

  const session = app.getOrCreateSession(req.body.sessionId);
  const handle = session.send(req.body);

  for await (const event of handle) {
    writer.writeEvent({ ...event, sessionId: req.body.sessionId });
  }

  const result = await handle;
  writer.writeEvent({ type: "result", result });
  writer.close();
});
```

## Why This Package Exists

Framework adapters (`@agentick/express`, `@agentick/nestjs`, etc.) need shared utilities:

1. **SSE helpers** - Consistent SSE formatting across adapters
2. **Type re-exports** - Convenient imports for adapter authors
3. **Error codes** - Standardized error responses

This package keeps the shared utilities in one place without duplicating code.

## What This Package Doesn't Do

- **Session management** - Use `@agentick/core` (`App`, `Session`)
- **Routing** - Use framework adapters (`@agentick/express`, etc.)
- **Authentication** - Handle in your framework middleware
- **Connection tracking** - Handled by framework adapters
